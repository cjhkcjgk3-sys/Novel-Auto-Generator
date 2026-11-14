// 名单、名录和图片共用同一套角色名规则，不要各自再写一份。
// 这里不依赖任何其他模块，避免和 roleImageLibrary / roleBatchState 形成循环引用。

function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

// ============================================
// 名称匹配：[作品名前缀] + 角色名 + [备注（皮肤/装甲/形态）]
// ============================================

const OPEN_BRACKETS = '(（[［{｛【〔〖「『《〈<＜';
const CLOSE_BRACKETS = ')）]］}｝】〕〗」』》〉>＞';

/** Fold width, brackets and case; brackets all become ASCII parentheses. */
export function unifyName(value) {
    let text = String(value ?? '').normalize('NFKC');
    let result = '';
    for (const character of text) {
        if (OPEN_BRACKETS.includes(character)) result += '(';
        else if (CLOSE_BRACKETS.includes(character)) result += ')';
        else result += character;
    }
    text = result.toLowerCase();
    return text;
}

/** Remove punctuation, symbols, spaces and middle dots; keep letters, digits and CJK. */
export function compact(value) {
    return unifyName(value).replace(/[\p{P}\p{S}\p{Cf}\p{Z}\s]+/gu, '');
}

/** Full-string key: only width, punctuation, brackets, spaces and case are ignored. */
export function normalizeRoleImageName(value) {
    return compact(value);
}

export function workKeysOf(workNames) {
    return uniqueStrings((Array.isArray(workNames) ? workNames : []).map(compact)).sort((a, b) => b.length - a.length);
}

/**
 * Split a name into role and notes, dropping the work name wherever it appears as a prefix or
 * as bracket content. `安比（绝区零）改`, `绝区零安比改` and `安比（改）` all give key `安比改`.
 * `work` is the removed work name (compact form), or '' when the name carries none.
 */
export function parseRoleImageName(value, workNames = []) {
    return parseWithWorkKeys(value, workKeysOf(workNames));
}

export function parseWithWorkKeys(value, workKeys) {
    const text = unifyName(value);
    let outside = '';
    const groups = [];
    let depth = 0;
    let current = '';
    for (const character of text) {
        if (character === '(') {
            if (depth > 0) current += character;
            depth++;
        } else if (character === ')' && depth > 0) {
            depth--;
            if (depth === 0) {
                groups.push(current);
                current = '';
            } else current += character;
        } else if (depth > 0) current += character;
        else outside += character;
    }
    if (depth > 0) outside += current;
    const workSet = new Set(workKeys);
    const compactGroups = groups.map(compact);
    const notes = compactGroups.filter((note) => note && !workSet.has(note));
    let work = compactGroups.find((note) => workSet.has(note)) || '';
    let role = compact(outside);
    for (const key of workKeys) {
        if (role.length > key.length && role.startsWith(key)) {
            role = role.slice(key.length);
            work ||= key;
            break;
        }
    }
    if (workSet.has(role)) {
        work ||= role;
        role = '';
    }
    if (!role && notes.length) role = notes.shift();
    return { role, notes, key: role + notes.join(''), work };
}

/**
 * 名录和名单之间比对“是不是同一个角色”。
 *
 * 名单可以不写作品名（`约克城II`），名录里记的可能是全名（`碧蓝航线·约克城II`）；
 * 图片匹配早就允许作品名可选，名录这里却一直是精确比较，于是同一个角色会被当成两个。
 * 规则和图片匹配保持一致：先去掉作品名比“角色名+备注”，作品名都写了就要求是同一个作品。
 * 作品名清单没登记时，退一步按“一个是另一个的后缀”认——只用于判断是否同一角色，不会用来配图。
 */
export function createRoleNameMatcher(names, workNames = []) {
    const entries = [];
    const suffixes = new Set();
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const parsed = parseRoleImageName(name, workNames);
        const compactName = compact(name);
        entries.push({ compact: compactName, work: parsed.work, key: parsed.key });
        // 只收长度 >= 2 的后缀，避免单字误配
        for (let start = 0; start < compactName.length - 1; start++) suffixes.add(compactName.slice(start));
    }
    const byKey = new Map();
    for (const entry of entries) {
        if (!entry.key) continue;
        if (!byKey.has(entry.key)) byKey.set(entry.key, []);
        byKey.get(entry.key).push(entry);
    }
    return {
        /** 名录里是否已经有这个角色（任一可接受写法都算）。 */
        has(value) {
            const name = String(value ?? '').trim();
            if (!name) return false;
            const parsed = parseRoleImageName(name, workNames);
            const candidates = byKey.get(parsed.key);
            if (candidates?.length) {
                // 名单没写作品名：认作同一个角色
                if (!parsed.work) return true;
                // 两边都写了作品名：必须是同一作品，或名录那条没写作品名
                if (candidates.some((entry) => !entry.work || entry.work === parsed.work)) return true;
            }
            const target = compact(name);
            return target.length > 1 && suffixes.has(target);
        },
    };
}

export { uniqueStrings };
