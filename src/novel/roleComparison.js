import { diffLines, diffStats, renderDiffHtml } from '../../txtToWorldbook/core/diff.js';

const MAX_CELLS = 200000;
const MAX_TEXT = 200000;
export const escapeComparisonText = (text) =>
    String(text).replace(
        /[&<>"']/g,
        (character) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[character],
    );

const escapeHtml = escapeComparisonText;

/** Keep each contiguous change together so replacements cannot be split line by line. */
export function buildRoleMergePlan(original, candidate) {
    if (original.length > MAX_TEXT || candidate.length > MAX_TEXT) return null;
    const a = original.split('\n').length,
        b = candidate.split('\n').length;
    if (a + b > 2000 || a * b > MAX_CELLS) return null;
    const groups = [];
    for (const hunk of diffLines(original, candidate)) {
        if (hunk.type === 'equal') {
            if (groups.at(-1)?.type !== 'equal') groups.push({ type: 'equal', lines: [] });
            groups.at(-1).lines.push(hunk.content);
        } else {
            if (groups.at(-1)?.type !== 'choice') groups.push({ type: 'choice', original: [], candidate: [] });
            groups.at(-1)[hunk.type === 'remove' ? 'original' : 'candidate'].push(hunk.content);
        }
    }
    return groups;
}

export function mergeRolePlan(plan, selections) {
    const lines = [];
    let index = 0;
    for (const group of plan) {
        if (group.type === 'equal') lines.push(...group.lines);
        else {
            const selection = selections[index++];
            if (selection !== 'original' && selection !== 'candidate') throw new Error('请选择每个差异段落的版本');
            lines.push(...group[selection]);
        }
    }
    return lines.join('\n');
}

function commonStructureError(oldValue, newValue, mergedValue, path = '根', depth = 0, seen = new WeakSet()) {
    const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
    if (kind(oldValue) !== kind(newValue)) return '';
    if (kind(mergedValue) !== kind(oldValue)) return `${path} 的数据类型发生变化`;
    if (kind(oldValue) !== 'object') return '';
    if (depth > 50) return '结构嵌套过深，无法安全校验';
    if (seen.has(mergedValue)) return '';
    seen.add(mergedValue);
    for (const key of Object.keys(oldValue)) {
        if (!Object.hasOwn(newValue, key)) continue;
        const field = `${path}.${key}`;
        if (!Object.hasOwn(mergedValue, key)) return `缺少共有字段：${field}`;
        const problem = commonStructureError(oldValue[key], newValue[key], mergedValue[key], field, depth + 1, seen);
        if (problem) return problem;
    }
    return '';
}

function structuredPayload(text) {
    const source = text.trim();
    const fence = source.match(/^```(json|ya?ml)\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
    if (fence) return { type: fence[1].toLowerCase() === 'json' ? 'json' : 'yaml', text: fence[2] };
    if (source.startsWith('{') || source.startsWith('[')) {
        try {
            JSON.parse(source);
            return { type: 'json', text: source };
        } catch {
            /* May be a card wrapper. */
        }
    }
    const inner = source
        .replace(/^```(?:text)?\s*\r?\n/i, '')
        .replace(/\r?\n```\s*$/, '')
        .replace(/^\[start\]\s*/i, '')
        .replace(/\s*\[end\]$/i, '');
    const wrapped = inner.match(/^<character_design_complex>\s*([\s\S]*?)\s*<\/character_design_complex>$/i);
    return wrapped ? { type: 'yaml', text: wrapped[1] } : null;
}

/** Check known syntax only; unknown custom card semantics still need user review. */
export function validateRoleMerge(original, candidate, merged, parseYaml) {
    if (!merged.trim()) return { ok: false, message: '合并结果为空，请重新选择段落' };
    for (const marker of ['[start]', '[end]', '<character_design_complex>', '</character_design_complex>', '```']) {
        const count = (value) => value.split(marker).length - 1;
        const oldCount = count(original),
            newCount = count(candidate);
        if (oldCount === newCount && oldCount > 0 && count(merged) !== oldCount)
            return { ok: false, message: `合并后结构标记 ${marker} 的数量发生变化，请重新选择段落` };
    }
    const left = structuredPayload(original),
        right = structuredPayload(candidate),
        output = structuredPayload(merged);
    if (left && right && left.type === right.type) {
        const parse = left.type === 'json' ? JSON.parse : parseYaml;
        if (typeof parse !== 'function')
            return { ok: true, message: '此格式无法自动校验，请仔细核对预览后保存为候选。' };
        let oldValue, newValue;
        try {
            oldValue = parse(left.text);
            newValue = parse(right.text);
        } catch {
            return { ok: true, message: '原版或新版未通过格式解析，请仔细核对预览后保存为候选。' };
        }
        if (!output || output.type !== left.type) return { ok: false, message: '合并后结构外壳不完整，请重新选择段落' };
        let value;
        try {
            value = parse(output.text);
        } catch {
            return { ok: false, message: `合并后 ${left.type.toUpperCase()} 格式有误，请调整选择` };
        }
        const structureError = commonStructureError(oldValue, newValue, value);
        if (structureError) return { ok: false, message: `合并后${structureError}，请调整选择` };
        return { ok: true, message: `${left.type.toUpperCase()} 格式检查通过；设定含义仍请人工核对。` };
    }
    return { ok: true, message: '此格式无法完整自动校验，请仔细核对预览后保存为候选。' };
}

/** Render raw text only after HTML escaping. */
export function renderMergeControls(plan) {
    if (!plan) return '<p>内容太长，无法安全计算段落合并。可在酒馆中手动编辑候选。</p>';
    const choices = plan.filter((group) => group.type === 'choice');
    if (!choices.length) return '<p>原版与候选内容相同，无需合并。</p>';
    const sections = choices
        .map((group, index) => {
            const text = (lines) => (lines.length ? escapeHtml(lines.join('\n')) : '（此版本无内容）');
            return `<fieldset class="nag-merge-block"><legend>差异段落 ${index + 1}</legend><label><input type="radio" name="nag-merge-${index}" value="original"> 原版<pre>${text(group.original)}</pre></label><label><input type="radio" name="nag-merge-${index}" value="candidate" checked> 新版<pre>${text(group.candidate)}</pre></label></fieldset>`;
        })
        .join('');
    return `<details class="nag-merge-panel"><summary>选择段落并合并</summary><p>每段选择一种版本；结构或格式有差异时请检查预览。合并后先保存为新的候选页。</p>${sections}<button type="button" class="menu_button nag-merge-preview">预览合并结果</button><p class="nag-merge-status" aria-live="polite"></p><textarea class="nag-merge-output" readonly rows="12" aria-label="合并结果预览"></textarea><button type="button" class="menu_button nag-merge-save" disabled>保存为合并候选</button></details>`;
}

/** Build a bounded comparison; never render character content as executable HTML. */
export function renderRoleComparison({ name, original, candidate, originalIndex, candidateIndex }) {
    const withinLength = original.length <= MAX_TEXT && candidate.length <= MAX_TEXT;
    const originalLines = withinLength ? original.split('\n').length : 0;
    const candidateLines = withinLength ? candidate.split('\n').length : 0;
    const bounded =
        withinLength && originalLines + candidateLines <= 2000 && originalLines * candidateLines <= MAX_CELLS;
    let diff;
    if (bounded) {
        const hunks = diffLines(original, candidate);
        const stats = diffStats(hunks);
        diff = `<p>按行比较：新增 ${stats.added} 行，删除 ${stats.removed} 行。红色为原版，绿色为候选版。</p>${renderDiffHtml(hunks)}`;
    } else {
        diff = '<p>内容较长，已跳过自动差异计算。请展开下方原文查看；每版最多显示前 20 万字符。</p>';
    }
    const display = (text) =>
        escapeHtml(text.slice(0, MAX_TEXT)) + (text.length > MAX_TEXT ? '\n……（内容过长，后续未显示）' : '');
    const plan = buildRoleMergePlan(original, candidate);
    return `<div class="nag-role-comparison"><p>角色：${escapeHtml(name)}｜原版第 ${originalIndex + 1} 页｜候选第 ${candidateIndex + 1} 页</p>${diff}${renderMergeControls(plan)}<div class="nag-comparison-versions"><details><summary>查看原版全文</summary><pre>${display(original)}</pre></details><details><summary>查看候选版全文</summary><pre>${display(candidate)}</pre></details></div></div>`;
}
