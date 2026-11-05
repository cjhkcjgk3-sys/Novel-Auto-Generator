import { expect, it } from 'vitest';
import { readRoleWorldbook, writeRoleWorldbook } from '../../src/novel/roleWorldbook.js';

const entry = (comment, content = '原有角色正文', uid = 7) => ({
    uid,
    comment,
    content,
    key: [comment],
    disable: true,
    order: 42,
    extraField: { preserved: true },
});

it('reads object and array worldbooks with the existing parser and keeps raw configuration', () => {
    for (const entries of [{ 7: entry('角色 - 琴') }, [entry('角色 - 琴')]]) {
        const input = { custom: 'book metadata', entries };
        const imported = readRoleWorldbook(input);
        expect(imported.roles[0]).toMatchObject({ name: '琴', text: '原有角色正文', entry: entry('角色 - 琴') });
        const exported = writeRoleWorldbook(imported.roles, imported);
        expect(Object.values(exported.entries)[0]).toEqual(entry('角色 - 琴'));
        expect(exported.custom).toBe('book metadata');
        expect(Array.isArray(exported.entries)).toBe(Array.isArray(entries));
        expect(input.entries).toEqual(entries);
    }
});

it('deduplicates names and accepts the first nonempty result without merging different forms', () => {
    const result = readRoleWorldbook({
        entries: [
            entry('琴', '', 0),
            entry('琴', '已有正文', 1),
            entry('琴', '第二份正文', 2),
            entry('三月七·存护', '存护正文', 3),
            entry('三月七·巡猎', '巡猎正文', 4),
        ],
    });
    expect(result.roles.map((role) => role.name)).toEqual(['琴', '三月七·存护', '三月七·巡猎']);
    expect(result.roles[0].text).toBe('已有正文');
    expect(result).toMatchObject({ duplicates: 1, skipped: 1 });
});

it('preserves explicit non-role entries and skips unnamed or empty candidates', () => {
    const world = entry('世界观 - 提瓦特', '世界资料', 0);
    const imported = readRoleWorldbook({ entries: [world, entry('琴', '正文', 1), { uid: 2, content: '没有名称' }] });
    expect(imported.roles.map((role) => role.name)).toEqual(['琴']);
    expect(imported.retained).toContainEqual(world);
    expect(imported.skipped).toBe(1);
    expect(Object.values(writeRoleWorldbook(imported.roles, imported).entries)).toContainEqual(world);
});

it('exports new and old results without changing text and allocates collision-free IDs', () => {
    const imported = readRoleWorldbook({ title: '旧世界书', entries: [entry('琴', ' 旧正文\n', 0)] });
    const result = writeRoleWorldbook(
        [...imported.roles, { name: '安柏', text: ' 新正文\n' }, imported.roles[0]],
        imported,
    );
    expect(result.title).toBe('旧世界书');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.uid)).toEqual([0, 1]);
    expect(result.entries.map((e) => e.content)).toEqual([' 旧正文\n', ' 新正文\n']);
    expect(result.entries[0]).toEqual(entry('琴', ' 旧正文\n', 0));
    expect(result.entries[1].key).toEqual(['安柏']);
});

it('rejects malformed or unusable books without including their contents in errors', () => {
    for (const input of [null, {}, { entries: 'private' }, { entries: [] }, { entries: [entry('', 'secret')] }])
        expect(() => readRoleWorldbook(input)).toThrow(/世界书|角色条目/);
});
