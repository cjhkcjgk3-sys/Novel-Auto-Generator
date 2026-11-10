import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';

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

/** Count pages whose role identity is not backed by the current batch's existing records. */
export function countUnidentifiedRolePages(batch, message) {
    if (!message) return 0;
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    const bindings = new Map();
    for (const item of [...(batch?.items || []), ...(batch?.history || [])]) {
        if (!Number.isInteger(item.swipe)) continue;
        if (!bindings.has(item.swipe)) bindings.set(item.swipe, []);
        bindings.get(item.swipe).push(item);
    }
    return swipes.reduce((count, text, index) => {
        if (typeof text !== 'string' || !text.trim() || text.trim() === '...') return count;
        const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch;
        if (receipt?.previewId) return count;
        const known = (bindings.get(index) || []).some(
            (item) => (receipt?.taskId === batch?.id && receipt.itemId === item.id) || (!receipt && item.legacy),
        );
        return count + (known ? 0 : 1);
    }, 0);
}
export const nextRoleIndex = (batch) => {
    const index = batch.items.findIndex((item) => !roleComplete(item));
    return index < 0 ? batch.names.length : index;
};

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
