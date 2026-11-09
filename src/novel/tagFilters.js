export function parseTagInput(s) {
    if (!s || typeof s !== 'string') return [];
    return s
        .split(/[,;，；\s\n\r]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

export function escapeTagName(tag) {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractTagContents(text, tags, separator = '\n\n') {
    if (!text || !tags || tags.length === 0) return '';
    const parts = [];
    for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        const escaped = escapeTagName(t);
        const pattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*/\\s*${escaped}\\s*>`, 'gi');
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const content = match[1].trim();
            if (content) parts.push(content);
        }
    }
    return parts.join(separator);
}

export function removeTagContents(text, tags) {
    if (!text || !tags || tags.length === 0) return text || '';
    let result = text;
    for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        const escaped = escapeTagName(t);
        const pairPattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\s*/\\s*${escaped}\\s*>`, 'gi');
        const selfClosingPattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?/\\s*>`, 'gi');
        result = result.replace(pairPattern, '').replace(selfClosingPattern, '');
    }
    return result.trim();
}

export function applyTagFilters(text, options = {}) {
    const { extractTags = [], excludeTags = [], extractMode = 'all', separator = '\n\n' } = options;
    if (!text) return '';

    let result = text;
    if (extractMode === 'tags' && extractTags.length > 0) {
        result = extractTagContents(result, extractTags, separator);
        if (!result) return '';
    }

    if (excludeTags.length > 0) {
        result = removeTagContents(result, excludeTags);
    }

    return result.trim();
}

/**
 * 校验角色卡文本是否完整闭合。
 * 若出现未闭合的代码块（```）、未配对的XML/结构标签、末尾截断标点或字数不足，则判定为截断。
 */
export function isRoleCardTruncated(text, options = {}) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed === '...') return false;

    const { minLength = 0, expectedClosingTags = [] } = options;

    if (minLength > 0 && trimmed.length < minLength) {
        return true;
    }

    // 1. Markdown 代码块三反引号成对闭合检查（奇数个 ``` 必然未闭合截断）
    const codeBlockTokens = trimmed.match(/```/g);
    if (codeBlockTokens && codeBlockTokens.length % 2 === 1) {
        return true;
    }

    // 2. 指定结束标签检查（若指定）
    if (Array.isArray(expectedClosingTags) && expectedClosingTags.length > 0) {
        const hasAnyClosed = expectedClosingTags.some((tag) => {
            const t = String(tag || '').trim();
            return t && trimmed.endsWith(t);
        });
        if (!hasAnyClosed) return true;
    }

    // 3. XML / 自定义成对标签首尾闭合检查
    const openTags = [];
    const tagPattern = /<\s*([a-zA-Z\u4e00-\u9fa5_][a-zA-Z0-9\u4e00-\u9fa5_-]*)(?:\s[^>]*)?\s*\/?>/g;
    const voidTags = new Set([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
    ]);
    let match;
    while ((match = tagPattern.exec(trimmed)) !== null) {
        const tagName = match[1].toLowerCase();
        if (voidTags.has(tagName) || /\/\s*>$/.test(match[0])) continue;
        openTags.push(tagName);
    }

    if (openTags.length > 0) {
        for (const tag of openTags) {
            const escaped = escapeTagName(tag);
            const closePattern = new RegExp(`<\\s*/\\s*${escaped}\\s*>`, 'i');
            if (!closePattern.test(trimmed)) {
                return true;
            }
        }
    }

    // 4. JSON 顶层大括号配对检查（以 { 开头时）
    if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
        return true;
    }

    // 5. 常见截断停顿标点（句子说到一半硬断掉）
    if (trimmed.length >= 20) {
        const trailingHangingPattern = /[，,、:：\\/（([【{\-~—]\s*$/;
        if (trailingHangingPattern.test(trimmed)) {
            return true;
        }
    }

    return false;
}
