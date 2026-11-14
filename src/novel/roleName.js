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

// Reverse UTF-16 code units so prefix comparison exactly preserves String#slice suffix semantics.
const reverseName = (name) => name.split('').reverse().join('');

/**
 * 名录和名单之间比对“是不是同一个角色”。
 *
 * 名单可以不写作品名（`约克城II`），名录里记的可能是全名（`碧蓝航线·约克城II`）；
 * 图片匹配早就允许作品名可选、忽略全／半角与括号，名录沿用同一解析规则。
 * 作品名清单没登记时，保留原有的后缀回退；这条规则不用于配图。
 */
export function createRoleNameMatcher(names, workNames = []) {
    const workKeys = workKeysOf(workNames);
    const byKey = new Map();
    const reversedNames = new Set();
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const parsed = parseWithWorkKeys(name, workKeys);
        const compactName = compact(name);
        if (compactName.length > 1) reversedNames.add(reverseName(compactName));
        if (!parsed.key) continue;
        if (!byKey.has(parsed.key)) byKey.set(parsed.key, new Set());
        byKey.get(parsed.key).add(parsed.work);
    }
    // A suffix of a name becomes a prefix of its reversal. Store one string per name,
    // rather than allocating every suffix (quadratic character storage for long names).
    const sortedNames = [...reversedNames].sort();
    return {
        /** 名录里是否已经有这个角色（任一可接受写法都算）。 */
        has(value) {
            const name = String(value ?? '').trim();
            if (!name) return false;
            const parsed = parseWithWorkKeys(name, workKeys);
            const works = byKey.get(parsed.key);
            if (works && (!parsed.work || works.has('') || works.has(parsed.work))) return true;
            const target = compact(name);
            if (target.length < 2) return false;
            const reversed = reverseName(target);
            let low = 0;
            let high = sortedNames.length;
            while (low < high) {
                const middle = low + Math.floor((high - low) / 2);
                if (sortedNames[middle] < reversed) low = middle + 1;
                else high = middle;
            }
            return sortedNames[low]?.startsWith(reversed) ?? false;
        },
    };
}

export { uniqueStrings };
