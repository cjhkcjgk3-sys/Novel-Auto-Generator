import { diffLines, diffStats, renderDiffHtml } from '../../txtToWorldbook/core/diff.js';

const MAX_CELLS = 200000;
const MAX_TEXT = 200000;
const escapeHtml = (text) =>
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

/** Build a bounded, read-only comparison; never render character content as executable HTML. */
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
    return `<div class="nag-role-comparison"><p>角色：${escapeHtml(name)}｜原版第 ${originalIndex + 1} 页｜候选第 ${candidateIndex + 1} 页</p>${diff}<div class="nag-comparison-versions"><details><summary>查看原版全文</summary><pre>${display(original)}</pre></details><details><summary>查看候选版全文</summary><pre>${display(candidate)}</pre></details></div></div>`;
}
