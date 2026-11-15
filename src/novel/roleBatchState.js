import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';
import { createRoleNameMatcher, parseWithWorkKeys, workKeysOf } from './roleName.js';

export const roleComplete = (item) =>
    item?.manualStatus === 'complete' || (item?.manualStatus !== 'failed' && !!item?.processed && !item.failed);
export const parseRoleNames = (text) => [
    ...new Set(
        String(text || '')
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter(Boolean),
    ),
];

/** Report repeated full names without changing spelling or combining different works/forms. */
export function duplicateRoleNames(text) {
    const seen = new Set(),
        duplicates = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
        const name = line.trim();
        if (!name) continue;
        if (seen.has(name)) duplicates.add(name);
        else seen.add(name);
    }
    return [...duplicates];
}

const PAGE_FINGERPRINT_OFFSET = 0x811c9dc5;

/** Small non-cryptographic digest: the signature only needs to notice changed page contents. */
function pageFingerprint(text) {
    let hash = PAGE_FINGERPRINT_OFFSET;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

/**
 * Pages whose role identity is not backed by the current batch's existing records.
 * A receipt naming a current item is sufficient: failed retries leave extra attempt pages that
 * no item points at, yet those pages already carry the retried role's identity.
 */
export function unidentifiedRolePages(batch, message) {
    if (!message) return [];
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    const candidates = [...(batch?.items || []), ...(batch?.history || [])];
    const identities = new Set(candidates.map((item) => item.id));
    const legacyPages = new Set(candidates.filter((item) => item.legacy).map((item) => item.swipe));
    const pages = [];
    swipes.forEach((text, index) => {
        if (typeof text !== 'string' || !text.trim() || text.trim() === '...') return;
        const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch;
        if (receipt?.previewId) return;
        const known = receipt
            ? receipt.taskId === batch?.id && !!receipt.itemId && identities.has(receipt.itemId)
            : legacyPages.has(index);
        if (!known) pages.push({ index, text });
    });
    return pages;
}

export const countUnidentifiedRolePages = (batch, message) => unidentifiedRolePages(batch, message).length;

/**
 * Fingerprint of the unresolved pages' contents. Indices are excluded so deleting unrelated pages
 * does not re-open the confirmation for pages the user already reviewed.
 */
export function unidentifiedRolePageSignature(batch, message) {
    return unidentifiedRolePages(batch, message)
        .map((page) => `${pageFingerprint(page.text)}:${page.text.length}`)
        .sort()
        .join(',');
}
export const nextRoleIndex = (batch) => {
    const index = batch.items.findIndex((item) => !roleComplete(item));
    return index < 0 ? batch.names.length : index;
};

/** Normalize the finished-role archive: trimmed, de-duplicated, original order kept. */
export function normalizeRoleArchive(archive) {
    const names = [];
    const seen = new Set();
    for (const entry of Array.isArray(archive) ? archive : []) {
        const name = String((typeof entry === 'string' ? entry : entry?.name) || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

export function mergeRoleArchive(archive, names, workNames = []) {
    const merged = normalizeRoleArchive(archive);
    const known = new Set(merged);
    // 收录时也要按「同一个角色」去重：名录里有「南达科他」，再完成一次
    // 「碧蓝航线·南达科他」不该多出一条。以前这里只比字符串。
    const matcher = createRoleNameMatcher(merged, workNames);
    for (const value of names || []) {
        const name = String(value || '').trim();
        if (!name || known.has(name)) continue;
        if (merged.length && matcher.has(name)) continue;
        known.add(name);
        merged.push(name);
    }
    return merged;
}

/**
 * 把名录里已经重复的不同写法合并成一个（例如「碧蓝航线·南达科他」与「南达科他」）。
 *
 * 只在「同一个解析键下、恰好有一个带作品名的写法 + 一个不带作品名的写法」时合并，
 * 保留带作品名的那条（信息更全）。同一角色名对应多个作品时不动，避免把
 * 「最终幻想7蒂法」和「最终幻想8蒂法」误并。
 */
export function dedupeRoleArchive(archive, workNames = []) {
    const names = normalizeRoleArchive(archive);
    const workKeys = workKeysOf(workNames);
    const groups = new Map();
    names.forEach((name, index) => {
        const parsed = parseWithWorkKeys(name, workKeys);
        if (!parsed.key) return;
        if (!groups.has(parsed.key)) groups.set(parsed.key, []);
        groups.get(parsed.key).push({ index, work: parsed.work });
    });
    const drop = new Set();
    for (const entries of groups.values()) {
        if (entries.length < 2) continue;
        // 同一作品（含都没写作品名）下的重复写法：只留第一条，
        // 例如 `长门·META` 与 `长门 META` 只差标点
        const seenWorks = new Set();
        const kept = [];
        for (const entry of entries) {
            if (seenWorks.has(entry.work)) {
                drop.add(entry.index);
                continue;
            }
            seenWorks.add(entry.work);
            kept.push(entry);
        }
        // 再处理「一个带作品名 + 一个不带」：保留带作品名的那条（信息更全）
        const bare = kept.filter((entry) => !entry.work);
        const works = new Set(kept.filter((entry) => entry.work).map((entry) => entry.work));
        if (bare.length === 1 && works.size === 1) drop.add(bare[0].index);
    }
    return drop.size ? names.filter((_, index) => !drop.has(index)) : names;
}

export function removeRoleArchiveName(archive, name) {
    const target = String(name || '').trim();
    return normalizeRoleArchive(archive).filter((entry) => entry !== target);
}

/**
 * Mark list entries the persisted archive already holds as finished without generating them again.
 * Releasing a name from the archive lets the next run regenerate that role.
 */
export function applyArchiveSkips(batch, archive, workNames = []) {
    // 名录里可能记着全名（碧蓝航线·约克城II），名单却只写角色名（约克城II），
    // 所以走和图片匹配同一套规则，而不是精确比较。
    const archived = createRoleNameMatcher(normalizeRoleArchive(archive), workNames);
    const skipped = [];
    for (const item of batch?.items || []) {
        const name = String(item.name || '').trim();
        if (archived.has(name)) {
            if (roleComplete(item)) continue;
            Object.assign(item, {
                archived: true,
                processed: true,
                failed: false,
                processing: false,
                manualStatus: null,
                swipe: null,
            });
            skipped.push(name);
        } else if (item.archived) {
            Object.assign(item, { archived: false, processed: false, processing: false });
        }
    }
    if (batch?.names) batch.index = nextRoleIndex(batch);
    return skipped;
}

export function hydrateRoleBatch(batch) {
    if (!batch) return null;
    const legacy = !batch.id;
    batch.id ??= newIdentity('role-batch');
    batch.schemaVersion = 1;
    batch.revision ??= 0;
    batch.history ??= [];
    batch.items = batch.names.map((name, index) => ({
        ...batch.items?.[index],
        name,
        id: batch.items?.[index]?.id || newIdentity('role'),
        legacy: batch.items?.[index]?.legacy ?? legacy,
        processing: false,
    }));
    updateRoleNames(batch, batch.names);
    return batch;
}

/** One task per full name; prefer an existing successful result and retain all other records. */
export function updateRoleNames(batch, names) {
    names = parseRoleNames(names.join('\n'));
    const pools = new Map();
    for (const item of [...batch.items, ...batch.history]) {
        item.name = item.name.trim();
        if (!pools.has(item.name)) pools.set(item.name, []);
        pools.get(item.name).push(item);
    }
    batch.items = names.map((name) => {
        const pool = pools.get(name);
        if (!pool?.length) return { id: newIdentity('role'), name };
        const manual = pool.findIndex((item) => item.manualStatus === 'complete' || item.manualStatus === 'failed');
        const completed = pool.findIndex(roleComplete);
        return pool.splice(manual >= 0 ? manual : completed < 0 ? 0 : completed, 1)[0];
    });
    batch.history = [...pools.values()].flat();
    batch.names = names;
    batch.index = nextRoleIndex(batch);
    batch.attempt = 0;
}
