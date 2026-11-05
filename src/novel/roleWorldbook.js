import { convertSTFormatToInternal } from '../worldbook/formats/sillyTavern.js';
import { createExportFormatService } from '../worldbook/formats/exportWorldbook.js';

export const ROLE_WORLDBOOK_KEY = 'nag_role_worldbook';
export const ROLE_ENTRY_KEY = 'nag_role_worldbook_entry';
const otherCategory =
    /^(?:世界观|世界设定|世界规则|背景|地点|场景|物品|规则|系统|作者说明|world|locations?|items?|rules?)$/i;

/**
 * 备选回复要在酒馆里显示成代码块，才能被酒馆助手渲染成前端窗口。
 * 写入备选页时包一层 ```text，导出世界书时再剥掉，保证数据本身始终是干净的角色卡文本。
 */
const CODE_FENCE = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/;

export function wrapCodeFence(text) {
    const value = String(text ?? '').trim();
    if (!value) return '';
    if (CODE_FENCE.test(value)) return value;
    return '```text\n' + value + '\n```';
}

export function unwrapCodeFence(text) {
    const value = String(text ?? '').trim();
    const matched = value.match(CODE_FENCE);
    return matched ? matched[1].trim() : value;
}

/** Use the existing ST parser; names come from explicit entry titles or primary keywords. */
export function readRoleWorldbook(input) {
    const root = input?.data?.character_book || input?.character_book || input;
    if (!root || typeof root !== 'object' || !root.entries || typeof root.entries !== 'object')
        throw new Error('文件不是可识别的世界书，请选择世界书 JSON 文件');
    const candidates = Object.values(root.entries).flatMap((original) => {
        const worldbook = convertSTFormatToInternal({ entries: [original] });
        return Object.entries(worldbook).flatMap(([category, entries]) =>
            Object.entries(entries).map(([name, entry]) => ({ category, name, entry })),
        );
    });
    const roles = [],
        retained = [],
        seen = new Set();
    let duplicates = 0,
        skipped = 0;
    for (const candidate of candidates) {
        const entry = candidate.entry._st;
        if (otherCategory.test(candidate.category)) {
            retained.push(entry);
            continue;
        }
        const explicit = entry.comment?.trim() || entry.name?.trim() || entry.key?.[0]?.trim();
        const name = (entry.comment?.trim() ? candidate.name : explicit || '').trim();
        const text = unwrapCodeFence(entry.content);
        if (!name || /[\r\n]/.test(name) || typeof text !== 'string' || !text.trim() || text.trim() === '...') {
            retained.push(entry);
            skipped++;
            continue;
        }
        if (seen.has(name)) {
            duplicates++;
            continue;
        }
        seen.add(name);
        roles.push({ name, text, entry });
    }
    if (!roles.length) throw new Error('世界书中没有带名称和正文的角色条目，原任务未改变');
    const metadata = structuredClone(root);
    delete metadata.entries;
    return { roles, retained, metadata, entriesAsArray: Array.isArray(root.entries), duplicates, skipped };
}

/** Imported fields remain intact; newly generated entries use the existing export formatter. */
export function writeRoleWorldbook(results, source = {}) {
    if (!results.length) throw new Error('没有成功的角色成果可导出');
    const formatter = createExportFormatService({
        AppState: { settings: { allowRecursion: false } },
        naturalSortEntryNames: (names) => names,
        getCategoryLightState: () => true,
        getCategoryAutoIncrement: () => false,
        getCategoryBaseOrder: () => 100,
        getEntryConfig: () => ({}),
    });
    const entries = [...structuredClone(source.retained || [])];
    const seen = new Set();
    for (const { name, text, entry } of results) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (entry) entries.push({ ...structuredClone(entry), content: text });
        else {
            const generated = formatter.convertToSillyTavernFormat({
                角色: { [name]: { 关键词: [name], 内容: text } },
            }).entries[0];
            delete generated.uid;
            entries.push({ ...generated, comment: name, content: text });
        }
    }
    const used = new Set();
    let next = entries.reduce(
        (next, entry) => (Number.isSafeInteger(Number(entry.uid)) ? Math.max(next, Number(entry.uid) + 1) : next),
        0,
    );
    for (const entry of entries) {
        if (entry.uid == null || used.has(String(entry.uid))) {
            while (used.has(String(next))) next++;
            entry.uid = next++;
        }
        used.add(String(entry.uid));
    }
    return {
        ...structuredClone(source.metadata || {}),
        entries: source.entriesAsArray ? entries : Object.fromEntries(entries.map((entry) => [entry.uid, entry])),
    };
}
