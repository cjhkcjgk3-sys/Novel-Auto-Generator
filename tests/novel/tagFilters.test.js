import { expect, it } from 'vitest';
import { parseTagInput, applyTagFilters, isRoleCardTruncated } from '../../src/novel/tagFilters.js';

it('preserves extraction and exclusion when moved out of the entry module', () => {
    expect(parseTagInput('正文，内容;备注')).toEqual(['正文', '内容', '备注']);
    expect(
        applyTagFilters('<正文>内容<备注>隐藏</备注></正文>', {
            extractMode: 'tags',
            extractTags: ['正文'],
            excludeTags: ['备注'],
        }),
    ).toBe('内容');
});

it('treats regex characters in tag names literally', () => {
    expect(applyTagFilters('<a.b>正确</a.b><axb>错误</axb>', { extractMode: 'tags', extractTags: ['a.b'] })).toBe(
        '正确',
    );
});

it('detects unclosed tags, unclosed code blocks and truncated text as incomplete', () => {
    // 1. 未闭合的 XML/自定义标签
    expect(isRoleCardTruncated('<character>\n姓名：琴\n性格：温柔')).toBe(true);
    expect(isRoleCardTruncated('<character>\n姓名：琴\n性格：温柔\n</character>')).toBe(false);

    // 2. 未闭合的 Markdown 代码块（奇数个 ```）
    expect(isRoleCardTruncated('```json\n{\n  "name": "琴"')).toBe(true);
    expect(isRoleCardTruncated('```json\n{\n  "name": "琴"\n}\n```')).toBe(false);

    // 3. 常见逗号/未完结标点挂起
    expect(isRoleCardTruncated('这是一个很长的角色设定描述，角色平时喜欢看书，并且性格十分，')).toBe(true);
    expect(isRoleCardTruncated('这是一个很长的角色设定描述，角色平时喜欢看书，并且性格十分温和。')).toBe(false);

    // 4. 字数过短检查
    expect(isRoleCardTruncated('琴', { minLength: 50 })).toBe(true);
    expect(isRoleCardTruncated('这是一个字数足够多的角色设定描述文本内容。', { minLength: 10 })).toBe(false);
});
