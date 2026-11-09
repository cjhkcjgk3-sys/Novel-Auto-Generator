import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';

// Minimal ST-like fixture: 3 role pages, user has page 1 (乙) selected (not the last page).
function fixture({ isolate = false } = {}) {
    const batch = {
        id: 'batch',
        identity: '1:chat',
        template: '写 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        items: ['甲', '乙', '丙'].map((name, i) => ({ id: `role${i}`, name, swipe: i, processed: true })),
        history: [],
    };
    const infos = batch.items.map((item) => ({
        extra: {
            nag_role_batch: { taskId: 'batch', itemId: item.id, status: 'complete', attemptId: `old-${item.id}` },
        },
    }));
    const events = new EventEmitter();
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
        eventSource: events,
        eventTypes: { MESSAGE_SWIPED: 'message_swiped', GENERATION_STARTED: 'generation_started' },
        addOneMessage: vi.fn(),
        updateMessageBlock: vi.fn(),
        generate: vi.fn(),
    };
    let disk = structuredClone(context.chat);
    context.saveChat = vi.fn(async () => {
        disk = structuredClone(context.chat);
    });
    // Same semantics as SillyTavern 1.19 public/script.js
    const syncMesToSwipe = (floor) => {
        const m = context.chat[floor];
        m.swipes[m.swipe_id] = m.mes;
        m.swipe_info[m.swipe_id].extra = structuredClone(m.extra);
        return true;
    };
    const syncSwipeToMes = (floor, index, target) => {
        const m = target || context.chat[floor];
        m.swipe_id = index;
        m.mes = m.swipes[index];
        m.extra = structuredClone(m.swipe_info?.[index]?.extra) ?? {};
        return true;
    };
    let mode = 'ok';
    // Mimics ST swipe(right, forceSwipeId = swipes.length): overswipe -> Generate('swipe');
    // on API error endSwipe() clamps swipe_id back to swipes.length - 1.
    const swipeReply = async (floor, swipeId) => {
        const m = context.chat[floor];
        syncMesToSwipe(floor);
        m.swipe_id = swipeId;
        await events.emit('generation_started', 'swipe');
        if (mode === 'apiError') {
            const back = m.swipes.length - 1;
            syncSwipeToMes(floor, back);
            return;
        }
        m.swipes.length++;
        m.mes = mode === 'stop' ? '乙新正文（被手动停止的半截' : '乙新正文';
        m.swipes[swipeId] = m.mes;
        m.swipe_info[swipeId] = { extra: structuredClone(m.extra) };
    };
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
        swipeReply,
        syncMesToSwipe,
        syncSwipeToMes,
        readSavedChat: async () => structuredClone(disk),
    });
    if (isolate) host.createRoleResultIsolation({ getBatch: () => batch });
    async function reroll() {
        const captured = await host.captureRoleReroll(batch);
        batch.dispatch = { itemId: captured.itemId, attemptId: 'attempt-' + Math.random() };
        try {
            const reply = await host.generateRoleReply(batch, '写 乙', {
                assertCurrent: () => {},
                timeoutMs: 5000,
                expectedPrompt: batch.template,
            });
            return await host.commitRoleReroll(batch, captured, reply.swipe);
        } finally {
            await host.restoreRoleRerollView(captured);
            await host.restoreRoleTemplateIfEquals(batch, '写 乙');
        }
    }
    return {
        batch,
        context,
        host,
        reroll,
        setMode: (v) => {
            mode = v;
        },
    };
}

it('baseline: rerolling a non-last page succeeds', async () => {
    const f = fixture();
    await f.reroll();
    expect(f.context.chat[2].swipes).toEqual(['甲原文', '乙新正文', '丙原文']);
});

it('after one host API error, a later reroll of the same floor still commits', async () => {
    const f = fixture();
    f.setMode('apiError');
    await expect(f.reroll()).rejects.toThrow('退回旧候选页');
    const m = f.context.chat[2];
    expect(m.swipe_info.length).toBe(m.swipes.length);
    f.setMode('ok');
    await expect(f.reroll()).resolves.toMatchObject({ index: 1 });
});

it('with result isolation on, an unsealed page does not make the reroll commit fail', async () => {
    const f = fixture({ isolate: true });
    // simulate an earlier stopped generation that left an unsealed partial page 3
    const m = f.context.chat[2];
    m.swipes.push('半截回复');
    m.swipe_info.push({
        extra: { nag_role_batch: { taskId: 'batch', itemId: 'role1', status: 'pending', attemptId: 'x' } },
    });
    // seal the original pages as a previous prepare() would have
    await f.host.createRoleResultIsolation({ getBatch: () => f.batch }).prepare();
    m.swipes.push('用户手动右划生成的新页');
    m.swipe_info.push({ extra: {} });
    await expect(f.reroll()).resolves.toMatchObject({ index: 1 });
});
