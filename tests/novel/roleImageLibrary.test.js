import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
    addNamesToRoster,
    clearRoleImageLibrary,
    createRoleImageIndex,
    getRoleImageForRequest,
    hasChecklistRoles,
    importRoleImageZip,
    listChecklistRoles,
    matchRoleImage,
    parseChecklistRoles,
    parseChecklistWorkNames,
    parseRoleImageName,
    setRoleImageDisabled,
} from '../../src/novel/roleImageLibrary.js';
import { canReadZipOnDemand, decodeFileName, openZip } from '../../src/novel/zipReader.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
}

/** Tiny ZIP writer for tests: entries = [{ name, data, deflate?, nameBytes?, utf8? }]. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
        const nameBytes = entry.nameBytes || new TextEncoder().encode(entry.name);
        const body = entry.deflate ? new Uint8Array(deflateRawSync(data)) : data;
        const flags = entry.utf8 === false ? 0 : 0x0800;
        const method = entry.deflate ? 8 : 0;
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, flags, true);
        lv.setUint16(8, method, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, flags, true);
        cv.setUint16(10, method, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, body.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        locals.push(local, body);
        centrals.push(central);
        offset += local.length + body.length;
    }
    const centralSize = centrals.reduce((total, part) => total + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return [...locals, ...centrals, end];
}

const zipFile = (entries, name = '作品.zip') => new File(makeZip(entries), name);

const ZZZ_MANIFEST = `# 绝区零角色图片清单

作品别名：绝区零、ZZZ、Zenless Zone Zero

- [x] [安比](<安比.png>) 别名：安比·德玛拉
- [x] [安比（改）](<安比（改）.png>)
- [x] [小安比](<小安比.png>)
- [x] [11号](<11号.png>) 别名：「11号」
- [ ] [缺图角色](<缺图角色.png>)
`;

function zzzEntries(prefix = '') {
    return [
        { name: `${prefix}00-清单.md`, data: ZZZ_MANIFEST },
        { name: `${prefix}安比.png`, data: PNG },
        { name: `${prefix}安比（改）.png`, data: PNG },
        { name: `${prefix}小安比.png`, data: PNG },
        { name: `${prefix}11号.png`, data: PNG },
    ];
}

function createHost() {
    const uploads = [];
    const deletes = [];
    return {
        uploads,
        deletes,
        uploadRoleImage: async (blob, id, extension) => {
            const path = `/user/images/novel-auto-generator-role-images/${id}.${extension}`;
            uploads.push({ path, size: blob.size, type: blob.type });
            return path;
        },
        deleteRoleImage: async (path) => {
            deletes.push(path);
        },
    };
}

const fakeThumbnail = async (blob) => {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] !== 0x89 || head[1] !== 0x50) return { ok: false };
    return { ok: true, thumbnail: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }) };
};

function library(items, workNames = ['绝区零', 'ZZZ', 'Zenless Zone Zero']) {
    return {
        workName: workNames[0],
        workNames,
        items: items.map((item, index) => ({
            path: `/user/images/novel-auto-generator-role-images/${index}.png`,
            aliases: [],
            fileName: item.name,
            ...item,
        })),
        noImageNames: [],
    };
}

describe('role image name matching', () => {
    const zzz = library([
        { name: '安比', aliases: ['安比·德玛拉'] },
        { name: '安比（改）' },
        { name: '小安比' },
        { name: '11号', aliases: ['「11号」'] },
        { name: '妮可' },
    ]);
    const match = (name, lib = zzz) => matchRoleImage(name, lib);
    const matchName = (name, lib = zzz) => match(name, lib).item?.name ?? null;

    it('splits work prefix, role and 备注', () => {
        expect(parseRoleImageName('安比（绝区零）改', ['绝区零'])).toEqual({
            role: '安比改',
            notes: [],
            key: '安比改',
        });
        expect(parseRoleImageName('【绝区零】安比（改）', ['绝区零'])).toEqual({
            role: '安比',
            notes: ['改'],
            key: '安比改',
        });
        expect(parseRoleImageName('绝区零·安比', ['绝区零']).key).toBe('安比');
        expect(parseRoleImageName('「11号」', ['绝区零']).key).toBe('11号');
    });

    it('matches exact full names first, ignoring width, brackets, spaces and dots', () => {
        expect(match('安比').tier).toBe('exact');
        expect(matchName('安比(改)')).toBe('安比（改）');
        expect(matchName('安比 · 德玛拉')).toBe('安比');
        expect(matchName('「11号」')).toBe('11号');
        expect(matchName('１１号')).toBe('11号');
    });

    it('strips the work name wherever it appears', () => {
        for (const name of [
            '安比（绝区零）',
            '【绝区零】安比',
            '绝区零安比',
            '绝区零·安比',
            'ZZZ安比',
            '安比(zzz)',
            '安比[Zenless Zone Zero]',
        ])
            expect(matchName(name), name).toBe('安比');
    });

    it('matches 角色名+备注 with or without brackets and with the work name anywhere', () => {
        for (const name of [
            '安比（绝区零）改',
            '绝区零安比改',
            '安比改',
            '安比（改）',
            '【绝区零】安比（改）',
            '安比（改）（绝区零）',
        ])
            expect(matchName(name), name).toBe('安比（改）');
        expect(match('安比（绝区零）改').tier).toBe('role');
        expect(match('【绝区零】安比（改）').tier).toBe('role-note');
    });

    it('applies base-image aliases to form images', () => {
        expect(matchName('安比·德玛拉（改）')).toBe('安比（改）');
        expect(matchName('绝区零安比德玛拉改')).toBe('安比（改）');
    });

    it('never falls back to the base image when a 备注 has no form image', () => {
        const result = match('安比（泳装）');
        expect(result.item).toBeNull();
        expect(result.reason).toContain('不使用本体图');
        expect(matchName('安比泳装')).toBeNull();
        expect(matchName('绝区零安比（泳装）')).toBeNull();
    });

    it('does no contains or partial matching', () => {
        expect(matchName('小安比')).toBe('小安比');
        expect(matchName('安')).toBeNull();
        expect(matchName('比')).toBeNull();
        expect(matchName('大安比')).toBeNull();
        expect(matchName('绝区零')).toBeNull();
        expect(matchName('')).toBeNull();
        const azur = library([{ name: '拉菲' }, { name: '小拉菲' }, { name: '拉菲（改造）' }], ['碧蓝航线']);
        expect(matchName('拉菲', azur)).toBe('拉菲');
        expect(matchName('小拉菲', azur)).toBe('小拉菲');
        expect(matchName('拉菲改造', azur)).toBe('拉菲（改造）');
        expect(matchName('碧蓝航线拉菲（改造）', azur)).toBe('拉菲（改造）');
        expect(matchName('拉菲改', azur)).toBeNull();
        expect(matchName('拉菲（改）', azur)).toBeNull();
    });

    it('returns no image with a reason when candidates are ambiguous', () => {
        const ambiguous = library([
            { name: '安比', aliases: ['特工'] },
            { name: '妮可', aliases: ['特工'] },
        ]);
        const exact = match('特工', ambiguous);
        expect(exact.status).toBe('ambiguous');
        expect(exact.item).toBeNull();
        expect(exact.reason).toContain('安比');
        expect(exact.reason).toContain('妮可');
        const sameStripped = library([{ name: '安比（改）' }, { name: '安比改' }]);
        expect(matchName('安比（改）', sameStripped)).toBeNull();
        expect(match('绝区零安比改', sameStripped).status).toBe('ambiguous');
    });

    it('takes work names only from the imported 清单', () => {
        const other = library([{ name: '安比' }], ['原神']);
        expect(matchName('原神安比', other)).toBe('安比');
        expect(matchName('绝区零安比', other)).toBeNull();
    });

    it('keeps per-role opt-out keyed by the roster name', () => {
        const disabled = setRoleImageDisabled('安比（绝区零）', true, zzz);
        expect(getRoleImageForRequest('安比（绝区零）', disabled)).toBeNull();
        expect(getRoleImageForRequest('安比（改）', disabled)?.name).toBe('安比（改）');
        expect(
            getRoleImageForRequest('安比（绝区零）', setRoleImageDisabled('安比（绝区零）', false, disabled))?.name,
        ).toBe('安比');
    });

    it('builds a reusable index', () => {
        const index = createRoleImageIndex(zzz);
        expect(matchRoleImage('安比改', zzz, index).item?.name).toBe('安比（改）');
        expect(matchRoleImage('安比改', zzz, index)).toBe(matchRoleImage('安比改', zzz, index));
    });
});

describe('checklist work names', () => {
    it('reads title, folder and 作品别名', () => {
        expect(parseChecklistWorkNames(ZZZ_MANIFEST)).toEqual(['绝区零', 'ZZZ', 'Zenless Zone Zero']);
        expect(parseChecklistWorkNames('作品别名：原神、Genshin', '原神')).toEqual(['原神', 'Genshin']);
        expect(parseChecklistWorkNames('# 碧蓝航线角色图片清单\n', 'images')).toEqual(['碧蓝航线', 'images']);
    });
});

describe('zip reader', () => {
    it('decodes UTF-8 flagged, unflagged UTF-8 and GBK names', () => {
        expect(decodeFileName(new TextEncoder().encode('绝区零/安比.png'), true)).toBe('绝区零/安比.png');
        expect(decodeFileName(new TextEncoder().encode('绝区零/安比.png'), false)).toBe('绝区零/安比.png');
        // "安比" in GBK
        expect(decodeFileName(new Uint8Array([0xb0, 0xb2, 0xb1, 0xc8]), false)).toBe('安比');
    });

    it('reads only the requested entry from the directory', async () => {
        const zip = await openZip(zipFile(zzzEntries('绝区零/')));
        expect(zip.entries.map((entry) => entry.name)).toContain('绝区零/安比（改）.png');
        const entry = zip.entries.find((item) => item.name === '绝区零/00-清单.md');
        expect(await (await zip.readEntry(entry)).text()).toBe(ZZZ_MANIFEST);
    });

    it.runIf(canReadZipOnDemand())('inflates deflated entries and enforces the size cap', async () => {
        const zip = await openZip(zipFile([{ name: 'a.md', data: 'x'.repeat(5000), deflate: true }]));
        expect(await (await zip.readEntry(zip.entries[0])).text()).toBe('x'.repeat(5000));
        await expect(zip.readEntry({ ...zip.entries[0], uncompressedSize: 10 }, { maxBytes: 100 })).rejects.toThrow();
    });

    it('rejects non-zip files', async () => {
        await expect(openZip(new File(['not a zip at all, definitely'], 'x.zip'))).rejects.toThrow('ZIP');
    });
});

describe('importRoleImageZip', () => {
    const options = { makeThumbnail: fakeThumbnail };

    it('imports a ZIP whose 00-清单.md is at the root and names the work from the title', async () => {
        const host = createHost();
        const result = await importRoleImageZip(
            zipFile(zzzEntries(), 'cjhkcjgk3-sys character-image-staging main images-绝区零.zip'),
            host,
            options,
        );
        expect(result.library.workName).toBe('绝区零');
        expect(result.library.workNames).toEqual(['绝区零', 'ZZZ', 'Zenless Zone Zero']);
        expect(result.imported).toBe(4);
        expect(result.skipped).toBe(1); // 缺图角色 is listed but has no file;
        expect(result.library.items.every((item) => item.thumbPath?.endsWith('-thumb.webp'))).toBe(true);
        expect(host.uploads).toHaveLength(8);
        expect(matchRoleImage('安比（绝区零）改', result.library).item?.name).toBe('安比（改）');
    });

    it('accepts one and two folder levels', async () => {
        for (const prefix of ['绝区零/', 'images/绝区零/']) {
            const result = await importRoleImageZip(zipFile(zzzEntries(prefix)), createHost(), options);
            expect(result.imported, prefix).toBe(4);
            expect(result.library.items[0].path).toMatch(/novel-auto-generator-role-images/);
        }
    });

    it('falls back to the folder and then the ZIP name when the 清单 has no title', async () => {
        const manifest = '- [x] [安比](安比.png)\n';
        const folder = await importRoleImageZip(
            zipFile([
                { name: '绝区零/00-清单.md', data: manifest },
                { name: '绝区零/安比.png', data: PNG },
            ]),
            createHost(),
            options,
        );
        expect(folder.library.workName).toBe('绝区零');
        const root = await importRoleImageZip(
            zipFile(
                [
                    { name: '00-清单.md', data: manifest },
                    { name: '安比.png', data: PNG },
                ],
                '鸣潮.zip',
            ),
            createHost(),
            options,
        );
        expect(root.library.workName).toBe('鸣潮');
    });

    it('imports GBK-named ZIPs from Chinese Windows tools', async () => {
        // GBK bytes: 安比 = b0b2 b1c8, 清单 = c7e5 b5a5
        const manifestName = new Uint8Array([0x30, 0x30, 0x2d, 0xc7, 0xe5, 0xb5, 0xa5, 0x2e, 0x6d, 0x64]);
        const imageName = new Uint8Array([0xb0, 0xb2, 0xb1, 0xc8, 0x2e, 0x70, 0x6e, 0x67]);
        const result = await importRoleImageZip(
            zipFile(
                [
                    {
                        name: '',
                        nameBytes: manifestName,
                        utf8: false,
                        data: '# 绝区零角色图片清单\n- [x] [安比](安比.png)\n',
                    },
                    { name: '', nameBytes: imageName, utf8: false, data: PNG },
                ],
                'zzz.zip',
            ),
            createHost(),
            options,
        );
        expect(result.library.items.map((item) => item.name)).toEqual(['安比']);
    });

    it('rejects ZIPs with several works or no 清单, and over 1 GB', async () => {
        await expect(
            importRoleImageZip(zipFile([...zzzEntries('a/'), ...zzzEntries('b/')]), createHost(), options),
        ).rejects.toThrow('只能包含一个作品');
        await expect(
            importRoleImageZip(zipFile([{ name: 'a.png', data: PNG }]), createHost(), options),
        ).rejects.toThrow('00-清单.md');
        const huge = { name: 'big.zip', size: 1024 * 1024 * 1024 + 1 };
        await expect(importRoleImageZip(huge, createHost(), options)).rejects.toThrow('1 GB');
        const big = { name: 'big.zip', size: 900 * 1024 * 1024 };
        const open = async () => ({ entries: [], readEntry: async () => new Blob() });
        await expect(importRoleImageZip(big, createHost(), { ...options, open })).rejects.toThrow('00-清单.md');
    });

    it('ignores macOS metadata entries and skips unreadable images', async () => {
        const result = await importRoleImageZip(
            zipFile(
                [
                    ...zzzEntries('绝区零/'),
                    { name: '__MACOSX/绝区零/._00-清单.md', data: 'junk' },
                    { name: '绝区零/._安比.png', data: 'junk' },
                ].map((entry) => (entry.name === '绝区零/小安比.png' ? { ...entry, data: 'broken' } : entry)),
            ),
            createHost(),
            options,
        );
        expect(result.imported).toBe(3);
        expect(result.skipped).toBe(2);
    });

    it('reads entries one at a time and reports progress', async () => {
        const reads = [];
        let active = 0;
        let maxActive = 0;
        const progress = [];
        const zip = await openZip(zipFile(zzzEntries('绝区零/')));
        const open = async () => ({
            entries: zip.entries,
            readEntry: async (entry, opts) => {
                active++;
                maxActive = Math.max(maxActive, active);
                reads.push(entry.name);
                try {
                    return await zip.readEntry(entry, opts);
                } finally {
                    active--;
                }
            },
        });
        await importRoleImageZip({ name: 'zzz.zip', size: 1 }, createHost(), {
            ...options,
            open,
            onProgress: (value) => progress.push(value),
        });
        expect(maxActive).toBe(1);
        expect(reads).toHaveLength(5);
        expect(progress.at(-1)).toEqual({ done: 5, total: 5 });
    });

    it('cleans up uploads when saving fails everywhere and clears thumbnails with images', async () => {
        const host = createHost();
        host.uploadRoleImage = async () => {
            throw new Error('nope');
        };
        await expect(importRoleImageZip(zipFile(zzzEntries()), host, options)).rejects.toThrow('酒馆未能保存图片');
        const ok = createHost();
        const result = await importRoleImageZip(zipFile(zzzEntries()), ok, options);
        const cleared = await clearRoleImageLibrary(result.library, ok);
        expect(cleared).toMatchObject({ library: null, deleted: 4, failed: 0 });
        expect(ok.deletes).toHaveLength(8);
    });
});

describe('checklist roles → roster', () => {
    const options = { makeThumbnail: fakeThumbnail };
    const MANIFEST = `# 碧蓝航线角色图片清单

作品别名：碧蓝航线、碧蓝

## 白鹰

### 超稀有

- [x] [拉菲](<拉菲.png>) 别名：Laffey
- [x] [拉菲（改造）](<拉菲（改造）.png>)
- [ ] 恶毒（μ兵装） 备注：残图，需重找
- [ ] 22 别名：二二
- [X] [拉菲](<拉菲.png>)

## 皮肤

### 白鹰

- [x] [拉菲（泳装）](<拉菲（泳装）.png>)
- [ ] 标枪（新春）

## 联动·哔哩哔哩

- [ ] 33
`;

    it('lists every 清单 name, checked or not, with 皮肤 entries separate', () => {
        expect(parseChecklistRoles(MANIFEST)).toEqual({
            roles: ['拉菲', '拉菲（改造）', '恶毒（μ兵装）', '22', '33'],
            skins: ['拉菲（泳装）', '标枪（新春）'],
        });
        expect(parseChecklistRoles('')).toEqual({ roles: [], skins: [] });
    });

    it('stores the names with the imported library', async () => {
        const result = await importRoleImageZip(zipFile(zzzEntries()), createHost(), options);
        expect(hasChecklistRoles(result.library)).toBe(true);
        expect(result.library.checklist).toEqual({
            roles: ['安比', '安比（改）', '小安比', '11号', '缺图角色'],
            skins: [],
        });
    });

    it('marks names already in the roster (exact full name) and names with images', async () => {
        const { library } = await importRoleImageZip(zipFile(zzzEntries()), createHost(), options);
        const view = listChecklistRoles(library, ' 安比 \n绝区零安比改\n');
        expect(view.total).toBe(5);
        expect(view.roles).toEqual([
            { name: '安比', inRoster: true, hasImage: true },
            { name: '安比（改）', inRoster: false, hasImage: true },
            { name: '小安比', inRoster: false, hasImage: true },
            { name: '11号', inRoster: false, hasImage: true },
            { name: '缺图角色', inRoster: false, hasImage: false },
        ]);
        expect(listChecklistRoles(library, '', '安比').roles.map((row) => row.name)).toEqual([
            '安比',
            '安比（改）',
            '小安比',
        ]);
        expect(listChecklistRoles(library, '', '安比(改)').roles.map((row) => row.name)).toEqual(['安比（改）']);
    });

    it('returns null for libraries imported before names were stored', () => {
        const legacy = { workName: '绝区零', workNames: ['绝区零'], items: [{ name: '安比', path: 'a.png' }] };
        expect(hasChecklistRoles(legacy)).toBe(false);
        expect(listChecklistRoles(legacy, '')).toBeNull();
        expect(listChecklistRoles(null, '')).toBeNull();
    });

    it('appends names in order and skips exact duplicates only', () => {
        expect(addNamesToRoster('安比\n\n妮可 ', ['妮可', '安比（改）', '安比（改）', ' 11号 ', ''])).toEqual({
            text: '安比\n妮可\n安比（改）\n11号',
            added: ['安比（改）', '11号'],
            skipped: 1,
        });
        expect(addNamesToRoster('', ['拉菲（泳装）']).text).toBe('拉菲（泳装）');
    });
});
