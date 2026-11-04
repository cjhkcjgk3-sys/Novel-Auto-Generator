import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';

export const roleComplete = (item) => !!item?.processed && !item.failed;
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
    return batch;
}

/** Match exact names in occurrence order, retaining removed records for later re-addition. */
export function updateRoleNames(batch, names) {
    const pools = new Map();
    for (const item of [...batch.items, ...batch.history]) {
        if (!pools.has(item.name)) pools.set(item.name, []);
        pools.get(item.name).push(item);
    }
    batch.items = names.map((name) => pools.get(name)?.shift() || { id: newIdentity('role'), name });
    batch.history = [...pools.values()].flat();
    batch.names = names;
    batch.index = nextRoleIndex(batch);
    batch.attempt = 0;
}
