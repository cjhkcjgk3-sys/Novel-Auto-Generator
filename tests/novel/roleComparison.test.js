import { expect, it } from 'vitest';
import {
    buildRoleMergePlan,
    mergeRolePlan,
    renderRoleComparison,
    validateRoleMerge,
} from '../../src/novel/roleComparison.js';

it('shows changes and escapes all character content', () => {
    const html = renderRoleComparison({
        name: '<角色>',
        original: '共同\n旧版<script>',
        candidate: '共同\n新版<img>',
        originalIndex: 4,
        candidateIndex: 9,
    });
    expect(html).toContain('新增 1 行，删除 1 行');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img>');
    expect(html).toContain('nag-merge-block');
    expect(html).toContain('原版第 5 页');
    expect(html).toContain('候选第 10 页');
});

it('merges selected contiguous changes while preserving either full version exactly', () => {
    const original = 'head\n性格: 温和\nshared\n兴趣: 读书\nend\n';
    const candidate = 'head\n性格: 勇敢\nshared\n兴趣: 旅行\nend\n';
    const plan = buildRoleMergePlan(original, candidate);
    expect(mergeRolePlan(plan, ['original', 'candidate'])).toBe('head\n性格: 温和\nshared\n兴趣: 旅行\nend\n');
    expect(mergeRolePlan(plan, ['original', 'original'])).toBe(original);
    expect(mergeRolePlan(plan, ['candidate', 'candidate'])).toBe(candidate);
    expect(() => mergeRolePlan(plan, ['original'])).toThrow('请选择');
});

it('handles added and removed blocks and preserves CRLF', () => {
    const original = 'a\r\nremove\r\nz\r\n';
    const candidate = 'a\r\ninsert\r\nz\r\n';
    const plan = buildRoleMergePlan(original, candidate);
    expect(mergeRolePlan(plan, ['original'])).toBe(original);
    expect(mergeRolePlan(plan, ['candidate'])).toBe(candidate);
});

it('prevents broken JSON or common wrapper markers and reports unsupported formats honestly', () => {
    const oldText = '{"name":"甲","title":"旧"}',
        newText = '{"name":"甲","title":"新"}';
    expect(validateRoleMerge(oldText, newText, '{"name":', null).ok).toBe(false);
    expect(validateRoleMerge(oldText, newText, '{"name":"甲"}', null).ok).toBe(false);
    expect(validateRoleMerge(oldText, newText, newText, null).ok).toBe(true);
    expect(validateRoleMerge('[start]\n旧\n[end]', '[start]\n新\n[end]', '[start]\n新', null).ok).toBe(false);
    expect(validateRoleMerge('旧版', '新版', '合并', null).message).toContain('无法完整自动校验');
    const oldNested = '{"name":"甲","settings":{"voice":"柔和","age":1}}';
    const newNested = '{"name":"甲","settings":{"voice":"坚定","age":2}}';
    expect(validateRoleMerge(oldNested, newNested, '{"name":"甲","settings":{"age":2}}', null).ok).toBe(false);
    expect(validateRoleMerge(oldNested, newNested, '{"name":"甲","settings":null}', null).ok).toBe(false);
});

it('uses the host YAML parser to reject a broken merged document', () => {
    const parseYaml = (text) => {
        if (text.includes('bad')) throw new Error('invalid');
        return { name: '甲' };
    };
    const oldText = '<character_design_complex>\nname: old\n</character_design_complex>';
    const newText = '<character_design_complex>\nname: new\n</character_design_complex>';
    expect(
        validateRoleMerge(
            oldText,
            newText,
            '<character_design_complex>\nname: bad\n</character_design_complex>',
            parseYaml,
        ).ok,
    ).toBe(false);
});

it('avoids quadratic diff for large inputs and clearly marks truncated raw text', () => {
    const html = renderRoleComparison({
        name: '甲',
        original: 'x'.repeat(200001),
        candidate: 'y',
        originalIndex: 0,
        candidateIndex: 1,
    });
    expect(html).toContain('已跳过自动差异计算');
    expect(html).toContain('内容过长，后续未显示');
});
