// 名称匹配组合测试（只读，不改插件行为）。
// 用法：node scripts/name-match-matrix.mjs [图片仓库根目录...]
// 默认读取 /workspace 下三个图片仓库的真实清单；找不到的作品自动跳过。
import fs from 'node:fs';
import path from 'node:path';
import { matchRoleImage, parseChecklistWorkNames, createRoleImageIndex } from '../src/novel/roleImageLibrary.js';

const roots = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['/workspace/character-image-staging', '/workspace/cis2', '/workspace/cis-azur'];
const WORKS = ['绝区零', '明日方舟', '星穹铁道', '原神', 'FGO', '碧蓝航线', '蔚蓝档案', '妮姬', '尘白禁区'];

function loadWork(work) {
    for (const root of roots) {
        const file = path.join(root, 'images', work, '00-清单.md');
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        const items = [];
        for (const line of text.split(/\r?\n/)) {
            const m = line.match(/^\s*-\s*\[[ xX]\]\s*\[([^\]]+)\]\((<[^>]+>|[^)]*)\)(.*)$/);
            if (!m) continue;
            const target = decodeURIComponent(m[2].replace(/^<|>$/g, '').trim());
            const alias = m[3].match(/(?:^|\s)别名[:：]\s*([^;；]*?)(?:\s+备注[:：].*)?\s*$/)?.[1] || '';
            items.push({
                name: m[1].trim(),
                aliases: alias
                    .split(/[、,，/／]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                fileName: path.basename(target).replace(/\.[^.]+$/, ''),
                path: `${work}/${target}`,
            });
        }
        return { workNames: parseChecklistWorkNames(text, work), items };
    }
    return null;
}

const toHalf = (s) => s.replace(/（/g, '(').replace(/）/g, ')');
const toFullAlnum = (s) => s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
function splitName(name) {
    const m = name.match(/^(.*?)（([^（）]+)）$/);
    return m ? { role: m[1], note: m[2] } : { role: name, note: '' };
}
function variants(name, work, alias) {
    const { role, note } = splitName(name);
    const v = {
        原样: name,
        半角括号: toHalf(name),
        前后空格: `  ${name} `,
        全角字母数字: toFullAlnum(name),
        小写: name.toLowerCase(),
    };
    v['作品前缀'] = work + name;
    v['作品·前缀'] = `${work}·${name}`;
    v['【作品】前缀'] = `【${work}】${name}`;
    v['别名作品前缀'] = alias + name;
    if (note) {
        v['后缀无括号'] = role + note;
        v['后缀〔〕'] = `${role}〔${note}〕`;
        v['后缀【】'] = `${role}【${note}】`;
        v['后缀·'] = `${role}·${note}`;
        v['作品括号在中间'] = `${role}（${work}）${note}`;
        v['作品括号在后'] = `${role}（${note}）（${work}）`;
    } else {
        v['作品括号在后'] = `${name}（${work}）`;
        v['名字中加空格'] = [...name].join(' ');
    }
    return v;
}

const stats = {};
const problems = [];
let total = 0;
function record(cat, kind, detail) {
    stats[cat] ??= { 正确: 0, 错图: 0, 无图: 0, 歧义: 0, 异常: 0 };
    stats[cat][kind]++;
    total++;
    if (kind !== '正确') problems.push({ cat, kind, ...detail });
}

// 1. 真实清单回环：每张图用自己名字的各种写法去查，期望命中自己
for (const work of WORKS) {
    const library = loadWork(work);
    if (!library || !library.items.length) continue;
    const index = createRoleImageIndex(library);
    const alias = library.workNames.find((n) => n !== work) || work;
    for (const item of library.items) {
        for (const [kind, query] of Object.entries(variants(item.name, work, alias))) {
            let r;
            try {
                r = matchRoleImage(query, library, index);
            } catch (e) {
                record(`${work}:${kind}`, '异常', { query, expected: item.name, got: String(e) });
                continue;
            }
            const outcome =
                r.status === 'matched'
                    ? r.item === item
                        ? '正确'
                        : '错图'
                    : r.status === 'ambiguous'
                      ? '歧义'
                      : '无图';
            record(`${work}:${kind}`, outcome, {
                query,
                expected: item.name,
                got: r.item?.name || '',
                reason: r.reason || '',
            });
        }
    }
}

// 2. 合成用例：明确期望（expect: 图片名 或 null 表示应无图）
const it = (name, aliases = []) => ({ name, aliases, fileName: name, path: `x/${name}` });
const synthetic = [
    {
        lib: { workNames: ['绝区零', 'ZZZ'], items: [it('安比'), it('安比（改）'), it('零号·安比'), it('小安比')] },
        cases: [
            ['安比', '安比'],
            ['零号安比', '零号·安比'],
            ['零号·安比', '零号·安比'],
            ['小安比', '小安比'],
            ['安比（零号）', null],
            ['原神安比', null],
            ['安比（原神）', null],
            ['ZZZ安比', '安比'],
            ['zzz安比', '安比'],
            ['安比改', '安比（改）'],
            ['安比（改造）', null],
            ['安比（泳装）', null],
            ['安比（改）（泳装）', null],
        ],
    },
    {
        lib: { workNames: ['明日方舟'], items: [it('凯尔希'), it('凯尔希·思衡托')] },
        cases: [
            ['凯尔希', '凯尔希'],
            ['凯尔希思衡托', '凯尔希·思衡托'],
            ['凯尔希（思衡托）', '凯尔希·思衡托'],
            ['思衡托', null],
        ],
    },
    {
        lib: {
            workNames: ['FGO', 'Fate/Grand Order'],
            items: [
                it('阿尔托莉雅·潘德拉贡'),
                it('阿尔托莉雅·潘德拉贡〔Alter〕'),
                it('阿尔托莉雅·潘德拉贡〔Alter〕（Lancer）'),
                it('阿尔托莉雅·卡斯特'),
                it('Saber', ['阿尔托莉雅']),
            ],
        },
        cases: [
            ['阿尔托莉雅', 'Saber'],
            ['阿尔托莉雅·潘德拉贡（Alter）', '阿尔托莉雅·潘德拉贡〔Alter〕'],
            ['阿尔托莉雅·潘德拉贡（Alter·Lancer）', '阿尔托莉雅·潘德拉贡〔Alter〕（Lancer）'],
            ['阿尔托莉雅·潘德拉贡（Alter）（Lancer）', '阿尔托莉雅·潘德拉贡〔Alter〕（Lancer）'],
            ['阿尔托莉雅·潘德拉贡（Lancer）（Alter）', null],
            ['阿尔托莉雅（Alter）', null],
            ['阿尔托莉雅·卡斯特', '阿尔托莉雅·卡斯特'],
            ['saber', 'Saber'],
            ['ＳＡＢＥＲ', 'Saber'],
            ['Fate/Grand Order·Saber', 'Saber'],
            ['Fate Grand Order Saber', 'Saber'],
        ],
    },
    {
        lib: {
            workNames: ['碧蓝航线', '碧蓝', 'Azur Lane'],
            items: [
                it('长门'),
                it('长门·META'),
                it('U-556'),
                it('U-556·META'),
                it('绊爱·Anniversary'),
                it('拉菲'),
                it('拉菲（改造）'),
                it('Z23'),
                it('Z23（改造）'),
            ],
        },
        cases: [
            ['长门（META）', '长门·META'],
            ['长门meta', '长门·META'],
            ['长门 META', '长门·META'],
            ['长门（meta）', '长门·META'],
            ['U556', 'U-556'],
            ['U-556（META）', 'U-556·META'],
            ['Ｕ－５５６', 'U-556'],
            ['绊爱', null],
            ['绊爱（Anniversary）', '绊爱·Anniversary'],
            ['拉菲改造', '拉菲（改造）'],
            ['拉菲改', null],
            ['碧蓝拉菲', '拉菲'],
            ['Azur Lane拉菲', '拉菲'],
            ['AzurLane拉菲', '拉菲'],
            ['z23改造', 'Z23（改造）'],
            ['长門', null],
        ],
    },
    {
        lib: {
            workNames: ['蔚蓝档案'],
            items: [it('白子'), it('白子（泳装）'), it('星野'), it('星野（泳装）', ['泳装星野'])],
        },
        cases: [
            ['白子（泳装）', '白子（泳装）'],
            ['泳装白子', null],
            ['泳装星野', '星野（泳装）'],
            ['（泳装）白子', '白子（泳装）'],
            ['白子（温泉）', null],
            ['白子(泳装)', '白子（泳装）'],
        ],
    },
    {
        lib: {
            workNames: ['崩坏3', '崩坏三'],
            items: [
                it('雷电芽衣（雷之律者）', ['雷之律者']),
                it('雷电芽衣（始源之律者）', ['始源之律者']),
                it('布洛妮娅·扎伊切克（理之律者）', ['理之律者']),
                it('布洛妮娅·扎伊切克（真理之律者）', ['真理之律者']),
            ],
        },
        cases: [
            ['雷电芽衣', null],
            ['雷之律者', '雷电芽衣（雷之律者）'],
            ['崩坏三雷之律者', '雷电芽衣（雷之律者）'],
            ['布洛妮娅（理之律者）', null],
            ['理之律者', '布洛妮娅·扎伊切克（理之律者）'],
            ['真理之律者', '布洛妮娅·扎伊切克（真理之律者）'],
            ['崩坏3rd雷电芽衣（雷之律者）', null],
        ],
    },
    {
        lib: {
            workNames: ['主机与PC游戏', '最终幻想7', '最终幻想8', '尼尔：机械纪元', '尼尔', '最终幻想1', '最终幻想10'],
            workGroups: [['尼尔：机械纪元', '尼尔']],
            items: [
                it('最终幻想7蒂法'),
                it('最终幻想7蒂法（女仆装）'),
                it('尼尔：机械纪元2B'),
                it('最终幻想1光之战士'),
            ],
        },
        cases: [
            ['最终幻想1光之战士', '最终幻想1光之战士'],
            ['最终幻想10光之战士', null],
            ['光之战士（最终幻想10）', null],
            ['蒂法', '最终幻想7蒂法'],
            ['蒂法（女仆装）', '最终幻想7蒂法（女仆装）'],
            ['最终幻想8蒂法', null],
            ['蒂法（最终幻想8）', null],
            ['2B', '尼尔：机械纪元2B'],
            ['尼尔2B', '尼尔：机械纪元2B'],
            ['尼尔:机械纪元2B', '尼尔：机械纪元2B'],
            ['2B（尼尔）', '尼尔：机械纪元2B'],
        ],
    },
    {
        lib: { workNames: ['原神'], items: [it('雷电将军', ['雷电影', '影']), it('影（冬日）')] },
        cases: [
            ['影', '雷电将军'],
            ['雷电影', '雷电将军'],
            ['影（冬日）', '影（冬日）'],
            ['雷电将军（冬日）', '影（冬日）'],
        ],
    },
    {
        lib: {
            workNames: ['蔚蓝档案', 'BA'],
            items: [it('白子', ['小白']), it('星野', ['小白']), it('白子（泳装·幼女）')],
        },
        cases: [
            ['', null],
            ['   ', null],
            ['（）', null],
            ['((((', null],
            [null, null],
            ['白子'.repeat(500), null],
            ['白子🌸', '白子'],
            ['小白', null],
            ['白子（泳装）（幼女）', '白子（泳装·幼女）'],
            ['白子（幼女·泳装）', '白子（泳装·幼女）'],
            ['白子（泳装', null],
            ['BA', null],
        ],
    },
    {
        lib: { workNames: ['空'], items: [it('空'), it('荧')] },
        cases: [
            ['空', '空'],
            ['荧', '荧'],
            ['空荧', null],
        ],
    },
];
for (const { lib, cases } of synthetic) {
    const index = createRoleImageIndex(lib);
    for (const [query, expected] of cases) {
        let r;
        try {
            r = matchRoleImage(query, lib, index);
        } catch (e) {
            record('合成', '异常', { query, expected, got: String(e) });
            continue;
        }
        const got = r.status === 'matched' ? r.item.name : null;
        let kind = '正确';
        if (got !== expected) kind = got && expected !== got ? '错图' : r.status === 'ambiguous' ? '歧义' : '无图';
        if (got && expected === null) kind = '错图';
        record('合成', kind, { query, expected: expected ?? '（应无图）', got: got ?? '', reason: r.reason || '' });
    }
}

console.log(`总用例 ${total}`);
for (const [cat, s] of Object.entries(stats)) {
    if (s.错图 || s.无图 || s.歧义 || s.异常) console.log(cat, JSON.stringify(s));
}
const byKind = {};
for (const p of problems) (byKind[p.kind] ??= []).push(p);
for (const [kind, list] of Object.entries(byKind)) {
    console.log(`\n== ${kind} ${list.length}`);
    const seen = new Map();
    for (const p of list) {
        const key = p.cat;
        if ((seen.get(key) || 0) >= 4) continue;
        seen.set(key, (seen.get(key) || 0) + 1);
        console.log(
            `  [${p.cat}] ${p.query} → ${p.got || '（无）'}（期望 ${p.expected}）${p.reason ? ' ' + p.reason : ''}`,
        );
    }
}
