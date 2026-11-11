import { expect, it } from 'vitest';
import { renderRoleComparison } from '../../src/novel/roleComparison.js';

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
    expect(html).toContain('原版第 5 页');
    expect(html).toContain('候选第 10 页');
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
