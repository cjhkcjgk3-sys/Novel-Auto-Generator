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
