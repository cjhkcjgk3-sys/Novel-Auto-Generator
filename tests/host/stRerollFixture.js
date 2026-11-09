// Shared SillyTavern 1.19 swipe/stream emulation for reroll tests (behaviour copied from public/script.js).
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';
import { ROLE_RESULT_INTERCEPTOR } from '../../src/host/resultIsolation.js';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';
import { createRoleBatchRecoveryStore } from '../../src/novel/recoveryStore.js';

// Async emitter like ST's (awaits each listener in order)
class StEvents extends EventEmitter {
    async emit(name, ...args) {
        for (const l of this.listeners(name)) await l(...args);
    }
}
export const CARD = (n) => `<角色>\n姓名：${n}\n` + '设定内容。'.repeat(30) + '\n</角色>';

export function fixture({
    isolate,
    skipSaves = 0,
    oldSync = false,
    selected,
    streaming = true,
    api = 'ok',
    newText = CARD('乙新'),
}) {
    const names = ['甲', '乙', '丙'];
    const batch = {
        id: 'batch',
        identity: '1:chat',
        template: '写 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        items: names.map((name, i) => ({ id: `role${i}`, name, swipe: i, processed: true })),
        history: [],
    };
    const infos = batch.items.map((item, i) => ({
        send_date: `d${i}`,
        gen_started: `s${i}`,
        gen_finished: `f${i}`,
        extra: {
            api: 'openai',
            model: 'm',
            reasoning: '',
            nag_role_batch: { taskId: 'batch', itemId: item.id, status: 'complete', attemptId: `old-${i}` },
        },
    }));
    const swipes = names.map((n) => CARD(n));
    const events = new StEvents();
    const context = {
        characterId: 1,
        chatId: 'chat',
        streamingProcessor: null,
        chat: [
            { mes: '开场', is_user: false },
            { is_user: true, mes: '写 [[角色名]]' },
            {
                is_user: false,
                mes: swipes[selected],
                swipe_id: selected,
                swipes,
                swipe_info: infos,
                send_date: infos[selected].send_date,
                gen_started: infos[selected].gen_started,
                gen_finished: infos[selected].gen_finished,
                extra: structuredClone(infos[selected].extra),
            },
        ],
        eventSource: events,
        eventTypes: {
            MESSAGE_SWIPED: 'message_swiped',
            GENERATION_STARTED: 'generation_started',
            MESSAGE_RECEIVED: 'message_received',
            GENERATION_STOPPED: 'generation_stopped',
        },
        addOneMessage: vi.fn(),
        updateMessageBlock: vi.fn(),
        generate: vi.fn(),
    };
    let disk = structuredClone(context.chat);
    let commitPhase = false;
    let generated = 0;
    context.saveChat = vi.fn(async () => {
        // ST saveChatConditional(): returns silently if another save is still running after 1s
        if (commitPhase && skipSaves > 0) {
            skipSaves--;
            return;
        }
        disk = structuredClone(context.chat);
    });
    const chat = context.chat;
    // ---- ST 1.19 functions (public/script.js) ----
    function syncMesToSwipe(id) {
        const t = chat[id];
        if (typeof t.swipe_id !== 'number' || !Array.isArray(t.swipe_info) || !Array.isArray(t.swipes)) return false;
        if (typeof t.swipes[t.swipe_id] !== 'string' || !t.swipe_info[t.swipe_id]) return false;
        const info = t.swipe_info[t.swipe_id];
        t.swipes[t.swipe_id] = t.mes;
        info.send_date = t.send_date;
        info.gen_started = t.gen_started;
        info.gen_finished = t.gen_finished;
        info.extra = structuredClone(t.extra);
        return true;
    }
    function syncSwipeToMes(id, swipeId = null, target = null) {
        const t = (oldSync ? null : target) || chat[id];
        if (swipeId !== null) t.swipe_id = swipeId;
        if (typeof t.swipes[t.swipe_id] !== 'string') return false;
        const info = t.swipe_info?.[t.swipe_id];
        t.mes = t.swipes[t.swipe_id];
        t.send_date = info?.send_date;
        t.gen_started = info?.gen_started;
        t.gen_finished = info?.gen_finished;
        t.extra = structuredClone(info?.extra) ?? {};
        return true;
    }
    function clearMessageData(m) {
        for (const k of [
            'memory',
            'display_text',
            'media',
            'inline_image',
            'files',
            'fileLength',
            'generationType',
            'negative',
            'title',
            'append_title',
        ])
            delete m.extra?.[k];
        delete m.gen_started;
        delete m.gen_finished;
    }
    async function saveReplySwipe(getMessage) {
        const last = chat[chat.length - 1];
        last.extra ??= {};
        last.swipes.length++;
        if (last.swipe_id === last.swipes.length - 1) {
            last.mes = getMessage;
            last.gen_started = 'gs';
            last.gen_finished = 'gf';
            last.send_date = 'now';
            last.extra.api = 'openai';
            last.extra.model = 'm';
            last.extra.reasoning = '';
            last.extra.reasoning_duration = null;
            last.extra.reasoning_signature = null;
        } else last.mes = getMessage;
        last.swipes[last.swipe_id] = last.mes;
        last.swipe_info[last.swipe_id] = {
            send_date: last.send_date,
            gen_started: last.gen_started,
            gen_finished: last.gen_finished,
            extra: structuredClone(last.extra),
        };
    }
    async function Generate(type) {
        await events.emit('generation_started', type, {}, false);
        // coreChat excludes the swiped message; interceptor receives shallow copies
        const coreChat = chat.slice(0, -1).map((m) => ({ ...m }));
        let aborted = false;
        await globalThis[ROLE_RESULT_INTERCEPTOR]?.(
            coreChat,
            1000,
            () => {
                aborted = true;
            },
            type,
        );
        if (aborted) return 'aborted';
        if (api === 'error') throw new Error('API 401');
        if (api === 'streamError') {
            context.streamingProcessor = { isFinished: false, isStopped: true };
            await saveReplySwipe('...');
            return '';
        }
        const id = chat.length - 1;
        if (streaming) {
            const proc = { isFinished: false, isStopped: false };
            context.streamingProcessor = proc;
            await saveReplySwipe('...');
            const text = typeof newText === 'function' ? newText(++generated) : newText;
            for (const part of [text.slice(0, 20), text]) {
                chat[id].mes = part;
                chat[id].gen_finished = 'gf2';
                chat[id].swipes[chat[id].swipe_id] = part;
                chat[id].swipe_info[chat[id].swipe_id] = {
                    send_date: chat[id].send_date,
                    gen_started: chat[id].gen_started,
                    gen_finished: chat[id].gen_finished,
                    extra: structuredClone(chat[id].extra),
                };
            }
            proc.isFinished = true;
            syncMesToSwipe(id);
            await events.emit('message_received', id, type);
            await context.saveChat();
            context.streamingProcessor = null;
        } else {
            await saveReplySwipe(typeof newText === 'function' ? newText(++generated) : newText);
            await events.emit('message_received', id, type);
            await context.saveChat();
        }
    }
    async function swipe(mesId, forceSwipeId) {
        const originalSwipeId = chat[mesId].swipe_id;
        syncMesToSwipe(mesId);
        let generation;
        if (forceSwipeId >= chat[mesId].swipes.length) {
            chat[mesId].swipe_id = chat[mesId].swipes.length;
            clearMessageData(chat[mesId]);
            await events.emit('message_swiped', mesId);
            generation = Generate('swipe');
        }
        try {
            await generation;
        } catch {}
        const clamped = Math.min(Math.max(chat[mesId].swipe_id, 0), chat[mesId].swipes.length - 1);
        if (chat[mesId].swipe_id !== clamped) {
            chat[mesId].swipe_id = clamped;
            clearMessageData(chat[mesId]);
            syncSwipeToMes(mesId, clamped);
        }
        void originalSwipeId;
    }
    const hostOptions = () => ({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
        swipeReply: (floor, id) => swipe(floor, id),
        syncMesToSwipe,
        syncSwipeToMes,
        readSavedChat: async () => structuredClone(disk),
    });
    let host = createSillyTavernHost(hostOptions());
    const iso = host.createRoleResultIsolation({ getBatch: () => (isolate ? batch : null) });
    async function reroll() {
        const captured = await host.captureRoleReroll(batch);
        batch.pending = true;
        batch.dispatch = { itemId: captured.itemId, attemptId: 'attempt-new' };
        try {
            const reply = await host.generateRoleReply(batch, `写 ${captured.name}`, {
                assertCurrent: () => {},
                timeoutMs: 5000,
                expectedPrompt: batch.template,
                validationOptions: { minLength: 100 },
            });
            if (!reply.text?.trim()) throw reply.error || new Error('empty');
            return await host.commitRoleReroll(batch, captured, reply.swipe);
        } finally {
            await host.restoreRoleRerollView(captured);
            await host.restoreRoleTemplateIfEquals(batch, `写 ${captured.name}`);
        }
    }
    async function runnerReroll() {
        Object.assign(batch, { names, index: 3, pending: false });
        const settings = {
            roleBatch: batch,
            roleNames: names.join('\n'),
            totalChapters: 3,
            minChapterLength: 100,
            generationMode: 'role-batch',
        };
        const notify = vi.fn(),
            onError = vi.fn();
        const runner = createRoleBatchRunner({
            getSettings: () => settings,
            host,
            onChange: () => {},
            notify,
            onStats: () => {},
            onError,
        });
        const origCommit = host.commitRoleReroll;
        host.commitRoleReroll = (...a) => {
            commitPhase = true;
            return origCommit(...a);
        };
        await runner.rerollSelected();
        return { notify, onError };
    }
    /** Runner over the live batch; `storage` emulates localStorage for the recovery journal. */
    function makeRunner(overrides = {}, storage = null) {
        Object.assign(batch, { names, index: 3 });
        const settings = {
            roleBatch: batch,
            roleNames: names.join('\n'),
            totalChapters: 3,
            minChapterLength: 100,
            generationMode: 'role-batch',
            ...overrides,
        };
        const notify = vi.fn(),
            onError = vi.fn();
        const recovery = storage ? createRoleBatchRecoveryStore(() => storage) : undefined;
        const runner = createRoleBatchRunner({
            getSettings: () => settings,
            host,
            onChange: () => {},
            notify,
            onStats: () => {},
            onError,
            recovery,
        });
        return { runner, settings, notify, onError };
    }
    /** Simulate a page reload: a fresh host, and a batch read back only from the persisted journal. */
    function reload(storage, overrides = {}) {
        host = createSillyTavernHost(hostOptions());
        const settings = {
            roleBatch: null,
            roleNames: '',
            minChapterLength: 100,
            generationMode: 'role-batch',
            ...overrides,
        };
        const notify = vi.fn(),
            onError = vi.fn();
        const runner = createRoleBatchRunner({
            getSettings: () => settings,
            host,
            onChange: () => {},
            notify,
            onStats: () => {},
            onError,
            recovery: createRoleBatchRecoveryStore(() => storage),
        });
        runner.restore();
        return { runner, settings, notify, onError, host };
    }
    return {
        batch,
        context,
        reroll,
        runnerReroll,
        makeRunner,
        reload,
        iso,
        getHost: () => host,
        getDisk: () => disk,
        setApi: (value) => {
            api = value;
        },
    };
}
