/**
 * 角色名单规模基准：用 1000 / 5000 / 10000 个角色跑一遍纯函数热路径，看哪一步会拖慢界面。
 *
 * 用法：node scripts/benchmark-role-scale.mjs
 * 这些是 JS 侧耗时，不含 DOM 渲染；手机上的实际帧时间还要加上列表重绘。
 */
import {
    parseRoleNames,
    duplicateRoleNames,
    updateRoleNames,
    applyArchiveSkips,
    normalizeRoleArchive,
} from '../src/novel/roleBatchState.js';
import { createRoleNameMatcher } from '../src/novel/roleName.js';
import { createRoleImageIndex, matchRoleImage, listChecklistRoles } from '../src/novel/roleImageLibrary.js';

function time(label, fn) {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    console.log(`${label.padEnd(40)}${ms.toFixed(1).padStart(9)} ms`);
    return result;
}

function makeNames(count) {
    return Array.from({ length: count }, (_, index) => `碧蓝航线·角色${index}号`);
}

function makeLibrary(count) {
    const items = Array.from({ length: count }, (_, index) => ({
        name: `角色${index}号`,
        path: `user/images/roles/${index}.jpg`,
        thumbPath: `user/images/roles/thumb-${index}.jpg`,
        fileName: `${index}.jpg`,
        aliases: [],
    }));
    return {
        workName: '碧蓝航线',
        workNames: ['碧蓝航线'],
        items,
        checklist: { roles: items.map((item) => item.name), skins: [] },
    };
}

function makeBatch(names) {
    return {
        id: 'bench',
        names: [...names],
        items: names.map((name, index) => ({ id: `item-${index}`, name })),
        history: [],
    };
}

for (const count of [1000, 5000, 10000]) {
    console.log(`\n===== 名单 ${count} 个 =====`);
    const names = makeNames(count);
    const text = names.join('\n');
    const library = makeLibrary(count);
    const batch = makeBatch(names);
    const archive = names.map((name) => name);

    time('parseRoleNames', () => parseRoleNames(text));
    time('duplicateRoleNames', () => duplicateRoleNames(text));
    const index = time('createRoleImageIndex（图片索引）', () => createRoleImageIndex(library));
    time('matchRoleImage × 全部名单', () => names.forEach((name) => matchRoleImage(name, library, index)));
    time('listChecklistRoles（清单面板）', () => listChecklistRoles(library, text, ''));
    time('updateRoleNames（名单变化重建）', () => updateRoleNames(batch, names));
    time('createRoleNameMatcher（名录）', () => createRoleNameMatcher(archive, ['碧蓝航线']));
    const matcher = createRoleNameMatcher(archive, ['碧蓝航线']);
    time('matcher.has × 全部名单', () => names.forEach((name) => matcher.has(name)));
    time('applyArchiveSkips', () => applyArchiveSkips(batch, archive, ['碧蓝航线']));
    time('normalizeRoleArchive', () => normalizeRoleArchive(archive));
}
