import { describe, expect, it } from 'vitest';
import { createRoleNameMatcher } from '../../src/novel/roleName.js';

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
});
