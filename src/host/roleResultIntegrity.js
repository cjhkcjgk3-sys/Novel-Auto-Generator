import { createFileUtils } from '../../txtToWorldbook/core/fileUtils.js';

export const RESULT_HASH_KEY = 'nag_result_hash';
export const hashRoleResult = createFileUtils({ fullContent: true }).calculateFileHash;

function changed(swipe) {
    return Object.assign(new Error('受保护的备选回复原文发生变化，已停止派发；请核对结果或关闭隔离后编辑'), {
        code: 'RESULT_CHANGED',
        phase: 'result-integrity',
        expectedSwipe: swipe,
        uncertain: true,
    });
}

/** Hash metadata lives with native swipe metadata; never duplicate the result bodies. */
export async function verifyRoleResults(message, { seal = false, assertCurrent = () => {} } = {}) {
    if (!message) return false;
    const selected = message.swipe_id ?? 0;
    const swipes = message.swipes || [message.mes];
    let modified = false;
    for (let index = 0; index < swipes.length; index++) {
        const text = index === selected ? message.mes : swipes[index];
        const expected =
            message.swipe_info?.[index]?.extra?.[RESULT_HASH_KEY] ??
            (index === selected ? message.extra?.[RESULT_HASH_KEY] : undefined);
        if (!expected && (!seal || typeof text !== 'string' || !text.trim() || text.trim() === '...')) continue;
        if (typeof text !== 'string') throw changed(index);
        const actual = await hashRoleResult(text);
        assertCurrent();
        if ((index === selected ? message.mes : swipes[index]) !== text || (message.swipe_id ?? 0) !== selected)
            throw changed(index);
        if (expected && actual !== expected) throw changed(index);
        if (index === selected && typeof swipes[index] === 'string' && swipes[index] !== text && expected)
            throw changed(index);
        if (!expected && seal) {
            message.swipe_info ??= [];
            message.swipe_info[index] ??= {};
            message.swipe_info[index].extra ??= {};
            message.swipe_info[index].extra[RESULT_HASH_KEY] = actual;
            if (index === selected) {
                message.extra ??= {};
                message.extra[RESULT_HASH_KEY] = actual;
            }
            modified = true;
        }
    }
    return modified;
}

export function clearRoleResultHashes(message) {
    if (!message) return;
    delete message.extra?.[RESULT_HASH_KEY];
    for (const info of message.swipe_info || []) delete info?.extra?.[RESULT_HASH_KEY];
}
