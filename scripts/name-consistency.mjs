/**
 * 名字匹配一致性检查：同一个角色在插件所有涉及名字身份的入口上必须给出同样的结论。
 *
 * 入口：名录判定（createRoleNameMatcher）、配图（matchRoleImage）、
 *      「不用图」标记（isRoleImageDisabled）、名录收录（mergeRoleArchive）、
 *      名录合并（dedupeRoleArchive）。
 * 任何一个入口给出不同答案就退出码 1。
 *
 * 用法：node scripts/name-consistency.mjs
 */
import assert from 'node:assert/strict';
import { createRoleNameMatcher } from '../src/novel/roleName.js';
import { matchRoleImage, isRoleImageDisabled } from '../src/novel/roleImageLibrary.js';
import { mergeRoleArchive, dedupeRoleArchive, normalizeRoleArchive } from '../src/novel/roleBatchState.js';

/** 每条用例：名录/图片里已有一条记录，再拿 query 去问，五个入口都必须给出同样的答案。 */
const CASES = [
    {
        id: '作品名前缀可选',
        stored: '碧蓝航线·南达科他',
        query: '南达科他',
        folder: '碧蓝航线',
        works: ['碧蓝航线'],
        same: true,
    },
    {
        id: '作品名前缀可选（反向）',
        stored: '南达科他',
        query: '碧蓝航线·南达科他',
        folder: '碧蓝航线',
        works: ['碧蓝航线'],
        same: true,
    },
    {
        id: '混合文件夹里不同作品的同名角色',
        stored: '最终幻想7蒂法',
        query: '最终幻想8蒂法',
        folder: '主机与PC游戏',
        works: ['主机与PC游戏', '最终幻想7', '最终幻想8'],
        same: false,
    },
    { id: '全角与半角', stored: '约克城II', query: '约克城ＩＩ', folder: '碧蓝航线', works: ['碧蓝航线'], same: true },
    {
        id: '括号样式与作品名位置',
        stored: '绝区零安比改',
        query: '安比（绝区零）改',
        folder: '绝区零',
        works: ['绝区零'],
        same: true,
    },
    {
        id: '同一角色的备注写法',
        stored: '安比（改）',
        query: '安比改',
        folder: '绝区零',
        works: ['绝区零'],
        same: true,
    },
    {
        id: '备注不同不等于同一形态',
        stored: '安比',
        query: '安比（改）',
        folder: '绝区零',
        works: ['绝区零'],
        same: false,
    },
    { id: '不做包含匹配', stored: '安比', query: '小安比', folder: '绝区零', works: ['绝区零'], same: false },
    {
        id: '本体与带编号形态',
        stored: '约克城II',
        query: '约克城',
        folder: '碧蓝航线',
        works: ['碧蓝航线'],
        same: false,
    },
    { id: '首尾空白', stored: '约克城II', query: '  约克城II  ', folder: '碧蓝航线', works: ['碧蓝航线'], same: true },
    {
        id: '间隔号与空格',
        stored: '长门·META',
        query: '长门 META',
        folder: '碧蓝航线',
        works: ['碧蓝航线'],
        same: true,
    },
];

function libraryOf(name, c) {
    return {
        workName: c.folder,
        workNames: c.works,
        items: [{ name, path: `${name}.jpg`, thumbPath: `${name}.jpg`, fileName: name, aliases: [] }],
        noImageNames: [],
        checklist: { roles: [], skins: [] },
    };
}

function imageMatches(entry, c) {
    const library = libraryOf(entry, c);
    return !!matchRoleImage(c.query, library).item;
}

function disabledFollows(entry, c) {
    const library = { ...libraryOf(entry, c), noImageNames: [entry] };
    return isRoleImageDisabled(c.query, library);
}

function mergeCollapses(entry, c) {
    return mergeRoleArchive([entry], [c.query], c.works).length === 1;
}

function dedupeCollapses(entry, c) {
    return dedupeRoleArchive([entry, c.query], c.works).length === 1;
}

const entries = [
    ['名录判定', (c) => createRoleNameMatcher([c.stored], c.works).has(c.query)],
    ['配图', (c) => imageMatches(c.stored, c)],
    ['不用图标记', (c) => disabledFollows(c.stored, c)],
    ['名录收录', (c) => mergeCollapses(c.stored, c)],
    ['名录合并', (c) => dedupeCollapses(c.stored, c)],
];

let failures = 0;
const rows = CASES.map((c) => {
    const got = entries.map(([label, run]) => {
        try {
            return { label, value: !!run(c) };
        } catch (error) {
            return { label, value: `错误: ${error.message}` };
        }
    });
    const disagree = got.filter((item) => item.value !== c.same);
    const consistent = disagree.length === 0;
    if (!consistent) {
        failures += 1;
        console.log(`\n✗ ${c.id}`);
        console.log(`  stored="${c.stored}" query="${c.query}" 期望 same=${c.same}`);
        for (const item of got) console.log(`    ${item.label.padEnd(10)} ${String(item.value)}`);
    }
    return { id: c.id, same: c.same, consistent };
});

console.log(`\n名字匹配一致性：${rows.length - failures}/${rows.length} 条用例全部入口一致`);
for (const row of rows)
    console.log(`  ${row.consistent ? '✓' : '✗'} ${row.id}（期望 ${row.same ? '同一角色' : '不同角色'}）`);

// 名录合并必须能清掉历史重复，且不能把不同作品并掉
assert.deepEqual(dedupeRoleArchive(['琴', '南达科他', '碧蓝航线·南达科他'], ['碧蓝航线']), ['琴', '碧蓝航线·南达科他']);
assert.deepEqual(normalizeRoleArchive([' 琴 ', '琴']), ['琴']);

if (failures > 0) {
    console.error(`\n有 ${failures} 条用例的入口结论不一致，名字规则出现了分叉。`);
    process.exit(1);
}
console.log('\n所有入口结论一致。');
