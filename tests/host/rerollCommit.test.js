import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';

function fixture() {
    const batch = {
        id: 'batch',
        identity: '1:chat',
        template: '写 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        items: ['甲', '乙', '丙'].map((name, i) => ({ id: `role${i}`, name, swipe: i, processed: true })),
        history: [],
        dispatch: { itemId: 'role1', attemptId: 'new-attempt' },
    };
    const infos = batch.items.map((item) => ({
        extra: {
            nag_role_batch: { taskId: 'batch', itemId: item.id, status: 'complete', attemptId: `old-${item.id}` },
            marker: item.name,
        },
    }));
    const context = {
        characterId: 1,
        chatId: 'chat',
        chat: [
            { mes: '开场' },
            { is_user: true, mes: '写 [[角色名]]' },
            {
                is_user: false,
                mes: '乙原文',
                swipe_id: 1,
                swipes: ['甲原文', '乙原文', '丙原文'],
                swipe_info: infos,
                extra: structuredClone(infos[1].extra),
            },
        ],
        eventSource: new EventEmitter(),
        eventTypes: { MESSAGE_SWIPED: 'message_swiped' },
        addOneMessage: vi.fn(),
        updateMessageBlock: vi.fn(),
    };
    let disk = structuredClone(context.chat),
        failSave = false;
    context.saveChat = vi.fn(async () => {
        if (!failSave) disk = structuredClone(context.chat);
    });
    const syncMesToSwipe = () => {
        const m = context.chat[2];
        m.swipes[m.swipe_id] = m.mes;
        m.swipe_info[m.swipe_id].extra = structuredClone(m.extra);
        return true;
    };
    const syncSwipeToMes = (_floor, index, m) => {
        m.swipe_id = index;
        m.mes = m.swipes[index];
        m.extra = structuredClone(m.swipe_info[index].extra);
        return true;
    };
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null }),
        syncMesToSwipe,
        syncSwipeToMes,
        readSavedChat: async () => structuredClone(disk),
    });
    function addNew() {
        context.chat[1].mes = '写 乙';
        const m = context.chat[2];
        m.swipes.push('乙新正文');
        m.swipe_info.push({
            extra: {
                nag_role_batch: { taskId: 'batch', itemId: 'role1', status: 'complete', attemptId: 'new-attempt' },
            },
        });
        m.swipe_id = 3;
        m.mes = m.swipes[3];
        m.extra = structuredClone(m.swipe_info[3].extra);
    }
    return {
        batch,
        context,
        host,
        addNew,
        getDisk: () => disk,
        setFailSave: (value) => {
            failSave = value;
        },
    };
}

it('asks before generating when an existing page has no reliable role binding', async () => {
    const f = fixture();
    const confirm = vi.fn(async () => false);
    f.context.Popup = { show: { confirm } };
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    f.context.chat[2].swipes.push('其他来源的角色卡');
    f.context.chat[2].swipe_info.push({});
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
});

it('does not ask again for abandoned retry pages that still name a current role', async () => {
    const f = fixture();
    const confirm = vi.fn(async () => true);
    f.context.Popup = { show: { confirm } };
    const message = f.context.chat[2];
    message.swipes.push('甲的重试残页');
    message.swipe_info.push({ extra: { nag_role_batch: { taskId: 'batch', itemId: 'role0', status: 'invalid' } } });
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
});

it('does not ask again right after the user confirmed a restart', async () => {
    const f = fixture();
    const confirm = vi.fn(async () => false);
    f.context.Popup = { show: { confirm } };
    f.context.chat[2].swipes.push('上一批留下的角色卡');
    f.context.chat[2].swipe_info.push({});
    f.batch.restartReviewed = true;
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    // The reviewed pages are remembered; a new unknown page asks again.
    delete f.batch.restartReviewed;
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    f.context.chat[2].swipes.push('又一张来历不明的角色卡');
    f.context.chat[2].swipe_info.push({});
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
});

it('does not ask twice for the same reviewed pages', async () => {
    const f = fixture();
    const confirm = vi.fn(async () => true);
    f.context.Popup = { show: { confirm } };
    const message = f.context.chat[2];
    message.swipes.push('来历不明的角色卡');
    message.swipe_info.push({});
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    // A newly added unknown page is a new review subject, so the dialog returns.
    message.swipes.push('第二张来历不明的角色卡');
    message.swipe_info.push({});
    expect(await f.host.confirmUnidentifiedRolePages(f.batch)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
});

it('does not overwrite a user-edited prompt when restoring the task template', async () => {
    const f = fixture();
    f.context.chat[1].mes = '用户正在修改的提示词';
    await f.host.restoreRoleTemplate(f.batch);
    expect(f.context.chat[1].mes).toBe('用户正在修改的提示词');
    expect(f.context.saveChat).not.toHaveBeenCalled();
});

it('keeps a manual failure despite an old completion receipt and recovers a newer completed attempt', async () => {
    const f = fixture();
    const item = f.batch.items[1];
    item.manualStatus = 'failed';
    item.failed = true;
    await f.host.reconcileRoleBatch(f.batch);
    expect(item).toMatchObject({ manualStatus: 'failed', processed: true, failed: true, swipe: 1 });
    f.addNew();
    f.batch.pending = true;
    f.batch.dispatch = { itemId: item.id, attemptId: 'new-attempt' };
    await f.host.reconcileRoleBatch(f.batch);
    expect(item).toMatchObject({ manualStatus: null, processed: true, failed: false, swipe: 3 });
    expect(f.context.chat[2].swipes.slice(0, 3)).toEqual(['甲原文', '乙原文', '丙原文']);
});

it('binds manually completed results only to their own receipts and never to a stale index', async () => {
    const f = fixture();
    const item = f.batch.items[1];
    item.manualStatus = 'complete';
    item.swipe = 0;
    f.context.chat[2].swipe_info[1].extra.nag_role_batch.status = 'partial';
    await f.host.reconcileRoleBatch(f.batch);
    expect(item).toMatchObject({ manualStatus: 'complete', processed: true, failed: false, swipe: 1 });
    delete f.context.chat[2].swipe_info[1].extra.nag_role_batch;
    await f.host.reconcileRoleBatch(f.batch);
    expect(item.swipe).toBeNull();
});

it('replaces the one selected swipe and persists all other bodies and metadata unchanged', async () => {
    const f = fixture(),
        captured = await f.host.captureRoleReroll(f.batch),
        original = structuredClone(captured.baseline);
    f.addNew();
    await f.host.commitRoleReroll(f.batch, captured, 3);
    expect(f.context.chat[2].swipes).toEqual(['甲原文', '乙新正文', '丙原文']);
    expect(f.getDisk()[2].swipes).toEqual(f.context.chat[2].swipes);
    expect(f.context.chat[2].swipe_info[0]).toEqual(original.swipe_info[0]);
    expect(f.context.chat[2].swipe_info[2]).toEqual(original.swipe_info[2]);
    expect(f.context.chat[2].swipe_id).toBe(1);
});

it('does not replace any page if another role changes during generation', async () => {
    const f = fixture(),
        captured = await f.host.captureRoleReroll(f.batch);
    f.addNew();
    f.context.chat[2].swipes[0] = '外部修改';
    await expect(f.host.commitRoleReroll(f.batch, captured, 3)).rejects.toMatchObject({ uncertain: true });
    expect(f.context.chat[2].swipes).toEqual(['外部修改', '乙原文', '丙原文', '乙新正文']);
});

it('refuses a completed candidate from a different generation attempt', async () => {
    const f = fixture();
    const captured = await f.host.captureRoleReroll(f.batch);
    f.addNew();
    f.context.chat[2].swipe_info[3].extra.nag_role_batch.attemptId = 'older-attempt';
    await expect(f.host.commitRoleReroll(f.batch, captured, 3)).rejects.toMatchObject({ uncertain: true });
    expect(f.context.chat[2].swipes.slice(0, 3)).toEqual(['甲原文', '乙原文', '丙原文']);
});

it('detects a save failure swallowed by the host and keeps the old page in memory and on disk', async () => {
    const f = fixture(),
        captured = await f.host.captureRoleReroll(f.batch);
    f.addNew();
    f.setFailSave(true);
    await expect(f.host.commitRoleReroll(f.batch, captured, 3)).rejects.toMatchObject({ uncertain: true });
    expect(f.context.chat[2].swipes[1]).toBe('乙原文');
    expect(f.getDisk()[2].swipes).toEqual(['甲原文', '乙原文', '丙原文']);
});

it('reports a display refresh failure after the replacement is safely persisted', async () => {
    const f = fixture(),
        captured = await f.host.captureRoleReroll(f.batch);
    f.addNew();
    f.context.addOneMessage.mockImplementation(() => {
        throw new Error('preview failed');
    });
    const result = await f.host.commitRoleReroll(f.batch, captured, 3);
    expect(result.refreshFailed).toBe(true);
    expect(f.getDisk()[2].swipes).toEqual(['甲原文', '乙新正文', '丙原文']);
});

it('refuses to overwrite a user-edited prompt template', async () => {
    const f = fixture();
    f.context.chat[1].mes = '用户刚编辑过的提示词';
    await expect(f.host.captureRoleReroll(f.batch)).rejects.toThrow('原始提示词已变化');
    expect(f.context.chat[1].mes).toBe('用户刚编辑过的提示词');
    expect(f.context.saveChat).not.toHaveBeenCalled();
});

it('does not commit if the prompt changes while the model is generating', async () => {
    const f = fixture();
    const captured = await f.host.captureRoleReroll(f.batch);
    f.addNew();
    f.context.chat[1].mes = '用户刚编辑过的提示词';
    await expect(f.host.commitRoleReroll(f.batch, captured, 3)).rejects.toMatchObject({ uncertain: true });
    expect(f.context.chat[1].mes).toBe('用户刚编辑过的提示词');
    expect(f.context.chat[2].swipes[1]).toBe('乙原文');
});

it('checks the prompt before dispatch and never overwrites a changed template', async () => {
    const f = fixture();
    f.context.chat[1].mes = '用户编辑后的提示词';
    await expect(
        f.host.generateRoleReply(f.batch, '写 乙', {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            expectedPrompt: f.batch.template,
        }),
    ).rejects.toThrow('原始提示词已变化');
    expect(f.context.chat[1].mes).toBe('用户编辑后的提示词');
    expect(f.context.saveChat).not.toHaveBeenCalled();
});
