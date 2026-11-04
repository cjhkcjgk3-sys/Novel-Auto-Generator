import { afterEach, expect, it, vi } from 'vitest';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';
import { EventEmitter } from 'node:events';

async function nativeSwipe(context, floor, swipeId) {
    context.eventSource.emit(context.eventTypes.GENERATION_STARTED, 'swipe');
    const reply = context.chat[floor];
    reply.swipes ??= [reply.mes];
    reply.swipe_info ??= [];
    const previous = reply.swipe_id ?? 0;
    reply.swipes[previous] = reply.mes;
    reply.swipe_info[previous] = { extra: structuredClone(reply.extra || {}) };
    reply.swipe_id = swipeId;
    reply.mes = '';
    reply.extra = {};
    await context.generate('swipe');
}

afterEach(() => vi.useRealTimers());
function setup() {
    const context = { chatId: 'a', characterId: 1, chat: [{ is_user: false, mes: '正文' }] };
    context.eventSource = new EventEmitter();
    context.eventTypes = { GENERATION_STOPPED: 'generation_stopped', GENERATION_STARTED: 'generation_started' };
    context.stopGeneration = vi.fn(() => context.eventSource.emit(context.eventTypes.GENERATION_STOPPED));
    const button = { length: 1, prop: vi.fn(() => false), trigger: vi.fn() };
    const input = { 0: { value: '' }, length: 1, val: vi.fn(), trigger: vi.fn() };
    input.trigger.mockReturnValue(input);
    const settings = {},
        save = vi.fn();
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null }),
        jquery: (selector) => (selector === '#send_but' ? button : input),
        extensionSettings: settings,
        saveSettings: save,
        swipeReply: (floor, swipeId) => nativeSwipe(context, floor, swipeId),
    });
    return { host, context, button, input, settings, save };
}

it('reads live identity and retains raw system message identity', () => {
    const { host, context } = setup();
    expect(host.snapshot().identity).toBe('1:a');
    context.chatId = 'b';
    context.chat.push({ is_system: true, mes: '系统' });
    expect(host.snapshot().identity).toBe('1:b');
    expect(host.snapshot().messages[1].isSystem).toBe(true);
});

it('checks the chat identity immediately before clicking send', async () => {
    vi.useFakeTimers();
    const { host, context, button } = setup();
    const identity = host.snapshot().identity;
    const task = host
        .send('继续', {
            assertCurrent: () => {
                if (host.snapshot().identity !== identity) throw new Error('switched');
            },
        })
        .catch((e) => e);
    context.chatId = 'b';
    await vi.runAllTimersAsync();
    expect((await task).message).toBe('switched');
    expect(button.trigger).not.toHaveBeenCalled();
});

it('cancels before dispatch and preserves settings container identity', async () => {
    vi.useFakeTimers();
    const { host, button, settings, save } = setup();
    host.writeSettings('plugin', { a: 1 });
    const original = settings.plugin;
    host.writeSettings('plugin', { b: 2 });
    expect(settings.plugin).toBe(original);
    expect(host.readSettings('plugin')).toEqual({ a: 1, b: 2 });
    expect(save).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const task = host.send('继续', { signal: controller.signal, assertCurrent: () => {} }).catch((e) => e);
    controller.abort();
    expect((await task).code).toBe('ABORTED');
    expect(button.trigger).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

it('reports unavailable controls as definitely not dispatched', async () => {
    const { host, button } = setup();
    button.length = 0;
    await expect(host.send('继续', { assertCurrent: () => {} })).rejects.toMatchObject({ dispatched: false });
});

function batchSetup(existing = true) {
    const { host, context } = setup();
    context.updateMessageBlock = vi.fn();
    context.saveChat = vi.fn(async () => {});
    context.chat = [
        { mes: '写卡助手', is_user: false },
        { mes: '生成 [[角色名]]', is_user: true },
    ];
    if (existing)
        context.chat.push({ mes: '旧成品', is_user: false, swipe_id: 0, swipes: ['旧成品'], extra: { note: '保留' } });
    const inputs = [];
    context.generate = vi.fn(async (type) => {
        context.eventSource.emit(context.eventTypes.GENERATION_STARTED, type);
        inputs.push({ type, history: structuredClone(type === 'swipe' ? context.chat.slice(0, -1) : context.chat) });
        const prompt = context.chat[1].mes;
        if (type === 'regenerate')
            context.chat.push({ is_user: false, mes: prompt, swipe_id: 0, swipes: [prompt], extra: {} });
        else {
            const last = context.chat.at(-1);
            last.swipes.length++;
            last.mes = prompt;
            last.swipes[last.swipe_id] = prompt;
        }
    });
    return { host, context, inputs };
}

it('updates the original user floor and appends swipes while preserving all old pages', async () => {
    const { host, context, inputs } = batchSetup();
    const batch = host.prepareRoleBatch();
    const options = { assertCurrent() {} };
    expect(await host.generateRoleReply(batch, '生成 琴', options)).toMatchObject({ text: '生成 琴', swipe: 1 });
    expect(await host.generateRoleReply(batch, '生成 安柏', options)).toMatchObject({ text: '生成 安柏', swipe: 2 });
    expect(context.chat).toHaveLength(3);
    expect(context.chat[1].mes).toBe('生成 安柏');
    expect(context.chat[2].swipes).toEqual(['旧成品', '生成 琴', '生成 安柏']);
    expect(context.chat[2].swipe_info[0].extra).toEqual({ note: '保留' });
    expect(inputs[1].history.map((m) => m.mes)).toEqual(['写卡助手', '生成 安柏']);
    expect(context.updateMessageBlock).toHaveBeenCalledWith(1, context.chat[1]);
});

it('creates the initial result floor without sending another user message', async () => {
    const { host, context, inputs } = batchSetup(false);
    const batch = host.prepareRoleBatch();
    await host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} });
    await host.generateRoleReply(batch, '生成 安柏', { assertCurrent() {} });
    expect(inputs.map((call) => call.type)).toEqual(['regenerate', 'swipe']);
    expect(batch.resultFloor).toBe(2);
    expect(context.chat.filter((m) => m.is_user)).toHaveLength(1);
    expect(context.chat[2].swipes).toEqual(['生成 琴', '生成 安柏']);
});

it('binds an empty newly created reply after failure so a retry can use the same floor', async () => {
    const { host, context } = batchSetup(false);
    const batch = host.prepareRoleBatch();
    context.generate.mockImplementationOnce(async () => {
        context.chat.push({ mes: '', is_user: false, swipe_id: 0, swipes: [''] });
        throw new Error('network');
    });
    await expect(host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} })).rejects.toThrow('network');
    expect(batch.resultFloor).toBe(2);
    await host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} });
    expect(context.chat).toHaveLength(3);
    expect(context.chat[2].swipes).toEqual(['', '生成 琴']);
});

it('bounds a hanging host request, aborts it and reports uncertainty', async () => {
    vi.useFakeTimers();
    const { host, context } = batchSetup();
    context.generate.mockImplementation(() => new Promise(() => {}));
    const task = host
        .generateRoleReply(host.prepareRoleBatch(), '生成 琴', { assertCurrent() {}, timeoutMs: 50 })
        .catch((error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await task).toMatchObject({ uncertain: true });
    expect(context.stopGeneration).toHaveBeenCalledOnce();
    expect(context.generate).toHaveBeenCalledWith('swipe');
    expect(vi.getTimerCount()).toBe(0);
});

it('rejects changed chats before updating text and marks only explicit truncation', async () => {
    const { host, context } = batchSetup();
    const batch = host.prepareRoleBatch();
    await expect(
        host.generateRoleReply(batch, '不能写入', {
            assertCurrent() {
                throw new Error('switched');
            },
        }),
    ).rejects.toThrow('switched');
    expect(context.chat[1].mes).toBe('生成 [[角色名]]');
    context.generate.mockRejectedValueOnce(Object.assign(new Error('limit'), { code: 'TOKEN_LIMIT' }));
    expect(await host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} })).toMatchObject({ truncated: true });
});

it('restores the placeholder on explicit reset without deleting generated pages', async () => {
    const { host, context } = batchSetup();
    const batch = { ...host.prepareRoleBatch(), identity: host.snapshot().identity };
    await host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} });
    const pages = [...context.chat[2].swipes];
    await host.restoreRoleTemplate(batch);
    expect(context.chat[1].mes).toBe('生成 [[角色名]]');
    expect(context.chat[2].swipes).toEqual(pages);
    context.chatId = 'other';
    context.chat[1].mes = '另一聊天';
    await host.restoreRoleTemplate(batch);
    expect(context.chat[1].mes).toBe('另一聊天');
});

it('does not accept a swallowed stream error or retain its temporary swipe', async () => {
    const { host, context } = batchSetup();
    const original = structuredClone(context.chat[2]);
    context.generate.mockImplementation(async () => {
        const reply = context.chat[2];
        reply.swipes.push('...');
        reply.mes = '...';
        context.streamingProcessor = { isStopped: true, isFinished: false };
    });
    const batch = host.prepareRoleBatch();
    for (let attempt = 0; attempt < 3; attempt++) {
        expect(await host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} })).toMatchObject({ text: '' });
        expect(context.chat[2]).toEqual(original);
    }
});

it('waits for the host to become idle even if generate resolves before streaming ends', async () => {
    vi.useFakeTimers();
    const { context } = batchSetup();
    let generating = false;
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => ({}) }),
        getStyle: () => ({ display: generating ? 'flex' : 'none' }),
        swipeReply: (floor, swipeId) => nativeSwipe(context, floor, swipeId),
    });
    context.generate.mockImplementation(async () => {
        generating = true;
        context.chat[2].mes = '...';
        setTimeout(() => {
            context.chat[2].mes = '完整正文';
            context.chat[2].swipes.push('完整正文');
            generating = false;
        }, 500);
    });
    let settled = false;
    const task = host.generateRoleReply(host.prepareRoleBatch(), '生成 琴', { assertCurrent() {} });
    task.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await task).toMatchObject({ text: '完整正文' });
});

it('preserves partial text when the host explicitly reports an interrupted stream', async () => {
    const { host, context } = batchSetup();
    context.generate.mockImplementation(async () => {
        context.chat[2].mes = '已经返回的半截正文';
        context.chat[2].swipes.push('已经返回的半截正文');
        context.streamingProcessor = { isStopped: true, isFinished: false };
    });
    expect(await host.generateRoleReply(host.prepareRoleBatch(), '生成 琴', { assertCurrent() {} })).toMatchObject({
        text: '已经返回的半截正文',
        truncated: true,
    });
    expect(context.chat[2].swipes).toEqual(['旧成品', '已经返回的半截正文']);
});

it('ends the waiting task immediately when the user stops generation in Tavern', async () => {
    vi.useFakeTimers();
    const { host, context } = batchSetup();
    context.generate.mockImplementation(() => new Promise(() => {}));
    const task = host.generateRoleReply(host.prepareRoleBatch(), '生成 琴', { assertCurrent() {} }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    context.stopGeneration();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await task).toMatchObject({ code: 'USER_STOPPED', uncertain: true });
    expect(context.eventSource.listenerCount(context.eventTypes.GENERATION_STOPPED)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => host.prepareRoleBatch()).toThrow('仍在退出');
});

it('does not accept existing content when native swipe never starts a generation', async () => {
    const { context } = batchSetup();
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null }),
        swipeReply: async () => {},
    });
    await expect(
        host.generateRoleReply(host.prepareRoleBatch(), '生成 安柏', { assertCurrent() {} }),
    ).rejects.toMatchObject({
        code: 'NOT_STARTED',
        phase: 'dispatch',
        expectedSwipe: 1,
        actualSwipe: 0,
    });
    expect(context.chat[2].mes).toBe('旧成品');
    expect(context.generate).not.toHaveBeenCalled();
});
