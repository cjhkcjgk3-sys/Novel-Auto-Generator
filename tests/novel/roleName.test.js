import { describe, expect, it } from 'vitest';
import { compact, createRoleNameMatcher, parseRoleImageName } from '../../src/novel/roleName.js';

// Preserve the previous matching rules as an independent oracle for the new index.
function previousMatcher(names, workNames) {
    const entries = names.filter(Boolean).map((name) => ({
        ...parseRoleImageName(name, workNames),
        full: compact(name),
    }));
    return (value) => {
        const name = String(value ?? '').trim();
        if (!name) return false;
        const parsed = parseRoleImageName(name, workNames);
        if (
            parsed.key &&
            entries.some(
                (entry) => entry.key === parsed.key && (!parsed.work || !entry.work || entry.work === parsed.work),
            )
        )
            return true;
        const target = compact(name);
        return target.length > 1 && entries.some((entry) => entry.full.endsWith(target));
    };
}

describe('createRoleNameMatcher', () => {
    it('treats a name with and without the work name as the same role', () => {
        const matcher = createRoleNameMatcher(['碧蓝航线·约克城II']);
        expect(matcher.has('约克城II')).toBe(true);
        expect(matcher.has('碧蓝航线·约克城II')).toBe(true);
        expect(matcher.has('碧蓝航线约克城II')).toBe(true);
    });

    it('keeps the same character from different works apart', () => {
        const matcher = createRoleNameMatcher(['最终幻想7蒂法']);
        expect(matcher.has('最终幻想8蒂法')).toBe(false);
        expect(matcher.has('蒂法')).toBe(true);
    });

    it('ignores width, brackets, punctuation and case', () => {
        const matcher = createRoleNameMatcher(['约克城II']);
        expect(matcher.has('  约克城ＩＩ ')).toBe(true);
        expect(matcher.has('约克城·ＩＩ')).toBe(true);
    });

    it('does not merge a base name with a numbered form', () => {
        const matcher = createRoleNameMatcher(['约克城II']);
        expect(matcher.has('约克城')).toBe(false);
    });

    it('uses the work name list when one is available', () => {
        const matcher = createRoleNameMatcher(['绝区零安比'], ['绝区零']);
        expect(matcher.has('安比')).toBe(true);
        expect(matcher.has('安比（改）')).toBe(false);
    });

    it('ignores empty input', () => {
        const matcher = createRoleNameMatcher(['琴', '', null]);
        expect(matcher.has('')).toBe(false);
        expect(matcher.has('琴')).toBe(true);
    });

    it('preserves previous results for suffixes, forms, works and Unicode', () => {
        const names = [
            '碧蓝航线·约克城II',
            '最终幻想7蒂法',
            '绝区零安比（改）',
            '琴',
            '𠮷野家角色',
            'ＡＢＣ（泳装）',
            '作品甲角色甲',
        ];
        const queries = ['', null, '不存在', '最终幻想8蒂法', '安比', '安比（改）', '约克城', '琴', 'abc泳装'];
        for (const name of names) {
            queries.push(name, ` ${name} `, `${name}额外`);
            const full = compact(name);
            for (let start = 0; start < full.length; start++) queries.push(full.slice(start));
        }
        for (const workNames of [[], ['碧蓝航线', '最终幻想7', '最终幻想8', '绝区零', '作品甲']]) {
            const previous = previousMatcher(names, workNames);
            const matcher = createRoleNameMatcher(names, workNames);
            for (const query of queries) expect(matcher.has(query), String(query)).toBe(previous(query));
        }
    });

    it('handles several thousand names, shared keys and missing suffixes', () => {
        const names = Array.from({ length: 5000 }, (_, index) => `作品${index}角色${index}号`);
        names.push('作品甲同名', '作品乙同名', '同名');
        const works = ['作品甲', '作品乙', '作品丙'];
        const matcher = createRoleNameMatcher(names, works);
        const previous = previousMatcher(names, works);
        for (const query of ['角色0号', '角色4999号', '角色5000号', '作品丙同名', '作品乙同名', '同名', '不存在'])
            expect(matcher.has(query), query).toBe(previous(query));
    });
});
