// @ts-check
/** Synchronous journal: storage must acknowledge uncertainty before the host dispatches. */
/** @param {() => Storage} getStorage @param {string} key */
export function createNovelRecoveryStore(getStorage, key = 'novel-auto-generator:recovery:v1') {
    return {
        read() {
            const raw = getStorage().getItem(key);
            if (raw == null) return null;
            const value = JSON.parse(raw);
            if (typeof value.identity !== 'string' || !Number.isInteger(value.chapter) || value.chapter < 0)
                throw new Error('Invalid continuation recovery record');
            if (
                value.pending &&
                (value.pending.identity !== value.identity ||
                    !Number.isInteger(value.pending.floor) ||
                    value.pending.floor < 0)
            )
                throw new Error('Invalid pending continuation');
            return value;
        },
        /** @param {{identity: string, chapter: number, pending: {identity: string, floor: number} | null}} record */
        write({ identity, chapter, pending }) {
            // Do not retain prompts or chat text in the journal.
            getStorage().setItem(
                key,
                JSON.stringify({
                    identity,
                    chapter,
                    pending: pending ? { identity: pending.identity, floor: pending.floor } : null,
                }),
            );
        },
        clear() {
            getStorage().removeItem(key);
        },
    };
}

/** Same synchronous journal, with the existing roleBatch record as its payload. */
/** @param {() => Storage} getStorage @param {string} key */
export function createRoleBatchRecoveryStore(getStorage, key = 'novel-auto-generator:role-batch:v1') {
    return {
        read() {
            const raw = getStorage().getItem(key);
            if (raw == null) return null;
            const record = JSON.parse(raw);
            if (record?.schemaVersion !== 1 || typeof record.updatedAt !== 'number')
                throw new Error('批量任务恢复记录无效，请查看错误日志');
            if (record.cleared === true) return record;
            if (
                typeof record.id !== 'string' ||
                typeof record.identity !== 'string' ||
                typeof record.template !== 'string' ||
                !Array.isArray(record.names) ||
                !record.names.every(/** @param {unknown} name */ (name) => typeof name === 'string') ||
                !Array.isArray(record.items) ||
                !Number.isInteger(record.promptFloor) ||
                record.promptFloor < 0
            )
                throw new Error('批量任务恢复记录不完整，请查看错误日志');
            return record;
        },
        /** @param {Record<string, any>} batch */
        write(batch) {
            getStorage().setItem(key, JSON.stringify(batch));
        },
        clear() {
            getStorage().setItem(key, JSON.stringify({ schemaVersion: 1, cleared: true, updatedAt: Date.now() }));
        },
    };
}
