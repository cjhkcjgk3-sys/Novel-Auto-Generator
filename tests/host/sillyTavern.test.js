import { afterEach, expect, it, vi } from 'vitest';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';
import { EventEmitter } from 'node:events';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';
import { createRoleBatchRecoveryStore } from '../../src/novel/recoveryStore.js';

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
    context.eventTypes = {
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_STARTED: 'generation_started',
        MESSAGE_RECEIVED: 'message_received',
    };
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
    context.addOneMessage = vi.fn();
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

it('reports a new host error when a started swipe returns to the previous page', async () => {
    const { context } = batchSetup();
    const oldNotice = {},
        newNotice = {};
    let notices = [oldNotice];
    const host = createSillyTavernHost({
        getContext: () => context,
        getDocument: () => ({ querySelector: () => null, querySelectorAll: () => notices }),
        swipeReply: async () => {
            context.eventSource.emit(context.eventTypes.GENERATION_STARTED, 'swipe');
            notices = [oldNotice, newNotice];
        },
    });
    await expect(
        host.generateRoleReply(host.prepareRoleBatch(), '生成 安柏', { assertCurrent() {} }),
    ).rejects.toMatchObject({
        phase: 'select-swipe',
        hostErrorNotice: true,
        expectedSwipe: 1,
        actualSwipe: 0,
        uncertain: true,
    });
    expect(context.chat[2].swipes).toEqual(['旧成品']);
});

it('writes completion receipts before native generation returns, so recovery can adopt a saved result', async () => {
    const { host, context } = batchSetup(false);
    const batch = {
        ...host.prepareRoleBatch(),
        id: 'task-1',
        identity: host.snapshot().identity,
        names: ['琴'],
        items: [{ id: 'role-1', name: '琴' }],
        pending: true,
        dispatch: { itemId: 'role-1', attemptId: 'try-1' },
    };
    let finish;
    context.generate.mockImplementation(async () => {
        context.eventSource.emit(context.eventTypes.GENERATION_STARTED, 'regenerate');
        context.chat.push({ mes: '正常完整结果', is_user: false, swipe_id: 0, swipes: ['正常完整结果'], extra: {} });
        context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, 2, 'normal');
        await new Promise((resolve) => {
            finish = resolve;
        });
    });
    const task = host.generateRoleReply(batch, '生成 琴', { assertCurrent() {} });
    while (!finish) await Promise.resolve();
    const savedChat = structuredClone(context.chat);
    expect(savedChat[2].swipe_info[0].extra.nag_role_batch.status).toBe('complete');
    const reopened = createSillyTavernHost({
        getContext: () => ({ ...context, chat: savedChat }),
        getDocument: () => ({ querySelector: () => null }),
    });
    await reopened.reconcileRoleBatch(batch);
    expect(batch.items[0]).toMatchObject({ processed: true, failed: false, swipe: 0 });
    expect(batch.pending).toBe(false);
    finish();
    await task;
});

it('does not adopt partial or unmarked text and repairs moved or deleted completed page bindings', async () => {
    const { host, context } = batchSetup();
    const batch = {
        ...host.prepareRoleBatch(),
        id: 'task-1',
        identity: host.snapshot().identity,
        names: ['琴'],
        items: [{ id: 'role-1', name: '琴' }],
        pending: true,
    };
    context.chat[2].swipe_info = [
        { extra: { nag_role_batch: { taskId: 'task-1', itemId: 'role-1', status: 'pending' } } },
    ];
    await host.reconcileRoleBatch(batch);
    expect(batch.items[0].processed).not.toBe(true);
    context.chat[2].swipes.push('完成结果');
    context.chat[2].swipe_info.push({
        extra: { nag_role_batch: { taskId: 'task-1', itemId: 'role-1', status: 'complete' } },
    });
    await host.reconcileRoleBatch(batch);
    expect(batch.items[0].swipe).toBe(1);
    context.chat[2].swipes.pop();
    context.chat[2].swipe_info.pop();
    await host.reconcileRoleBatch(batch);
    expect(batch.items[0].processed).toBe(false);
});

it('retains a failed result when an old complete receipt has text that fails the same validation used at generation', async () => {
    const { host, context } = batchSetup();
    const invalid = '<card>有正文但没有闭合的角色卡。';
    Object.assign(context.chat[2], {
        mes: invalid,
        swipes: [invalid],
        swipe_info: [{ extra: { nag_role_batch: { taskId: 'task', itemId: 'role', status: 'complete' } } }],
    });
    const batch = {
        ...host.prepareRoleBatch(),
        identity: host.snapshot().identity,
        id: 'task',
        items: [{ id: 'role', name: '角色', processed: true, failed: true, swipe: 0 }],
    };
    await host.reconcileRoleBatch(batch, { minLength: 10, expectedClosingTags: ['</card>'] });
    expect(batch.items[0].failed).toBe(true);
});

it('does not persist an invalid nonempty generation as a complete result', async () => {
    const { host, context } = batchSetup(false);
    const invalid = '<card>有正文但没有闭合的角色卡。';
    const batch = {
        ...host.prepareRoleBatch(),
        identity: host.snapshot().identity,
        id: 'task',
        items: [{ id: 'role', name: '角色' }],
        dispatch: { itemId: 'role', attemptId: 'attempt' },
    };
    context.generate.mockImplementation(async (type) => {
        context.eventSource.emit(context.eventTypes.GENERATION_STARTED, type);
        context.chat.push({ is_user: false, mes: invalid, swipe_id: 0, swipes: [invalid], extra: {} });
        context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, 2);
    });
    await host.generateRoleReply(batch, '生成 角色', {
        assertCurrent() {},
        validationOptions: { minLength: 10, expectedClosingTags: ['</card>'] },
    });
    expect(context.chat[2].swipe_info[0].extra.nag_role_batch.status).toBe('invalid');
});

it('keeps legacy completion bindings until the migrated chat receipts are saved', async () => {
    const { host, context } = batchSetup();
    const batch = {
        ...host.prepareRoleBatch(),
        id: 'migrated-task',
        identity: host.snapshot().identity,
        items: [{ id: 'legacy-role', name: '琴', legacy: true, processed: true, swipe: 0 }],
    };
    context.saveChat.mockRejectedValueOnce(new Error('save failed'));
    await expect(host.reconcileRoleBatch(batch)).rejects.toThrow('save failed');
    expect(batch.items[0].legacy).toBe(true);
    await host.reconcileRoleBatch(batch);
    expect(context.saveChat).toHaveBeenCalledTimes(2);
    expect(batch.items[0]).toMatchObject({ processed: true, failed: false, legacy: false });
});

it('does not modify a prompt or dispatch when Tavern has no API connection', async () => {
    const { host, context } = batchSetup();
    context.onlineStatus = 'no_connection';
    await expect(
        host.generateRoleReply(host.prepareRoleBatch(), '生成 琴', { assertCurrent() {} }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(context.chat[1].mes).toBe('生成 [[角色名]]');
    expect(context.generate).not.toHaveBeenCalled();
});

function workbenchSetup(existing = false) {
    const f = batchSetup(existing);
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const recovery = createRoleBatchRecoveryStore(() => storage);
    const create = (settings = { roleNames: '', replyWaitTime: 0, roleBatch: null }) => ({
        settings,
        runner: createRoleBatchRunner({
            getSettings: () => settings,
            host: f.host,
            recovery,
            notify: vi.fn(),
            onChange: vi.fn(),
            onStats: vi.fn(),
        }),
    });
    return { ...f, recovery, storage, create };
}
const importedBook = {
    name: '旧角色世界书',
    custom: { preserved: true },
    entries: {
        41: {
            uid: 41,
            comment: '琴',
            key: ['琴', '团长'],
            content: '<legacy>旧角色原文',
            disable: true,
            order: 57,
            customField: 'preserved',
        },
        42: { uid: 42, comment: '安柏', key: ['安柏'], content: '已有角色正文', order: 58 },
    },
};

it('imports to native swipes, restores success under new validation rules and continues only missing names', async () => {
    vi.useFakeTimers();
    const f = workbenchSetup();
    const first = f.create();
    expect(await first.runner.importWorldbook(importedBook)).toMatchObject({ added: 2, duplicates: 0 });
    expect(first.settings.roleNames).toBe('琴\n安柏');
    expect(first.settings.totalChapters).toBe(2);
    expect(first.settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
    expect(f.context.chat[2].swipes).toEqual(['<legacy>旧角色原文', '已有角色正文']);
    expect(f.context.addOneMessage).toHaveBeenCalledOnce();
    const savedChat = JSON.parse(JSON.stringify(f.context.chat));
    f.context.chat = savedChat;
    const second = f.create({ roleNames: '', minChapterLength: 10000, expectedClosingTags: ['</new-card>'] });
    second.runner.restore();
    await second.runner.resetPending();
    expect(second.settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
    second.settings.roleNames += '\n丽莎\n琴\n 丽莎 ';
    second.settings.expectedClosingTags = [];
    second.settings.minChapterLength = 0;
    second.runner.saveInput();
    const generate = f.context.generate.getMockImplementation();
    f.context.generate.mockImplementation(async (...args) => {
        await generate(...args);
        f.context.chat.at(-1).extra.nag_role_worldbook_entry = structuredClone(importedBook.entries[41]);
    });
    const task = second.runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0].history.map((m) => m.mes)).toEqual(['写卡助手', '生成 丽莎']);
    expect(second.settings.roleBatch.names).toEqual(['琴', '安柏', '丽莎']);
    expect(f.context.chat[2].swipes.slice(0, 2)).toEqual(['<legacy>旧角色原文', '已有角色正文']);
    const exported = await second.runner.exportWorldbook();
    expect(exported.custom).toEqual({ preserved: true });
    expect(exported.entries[41]).toEqual(importedBook.entries[41]);
    expect(Object.values(exported.entries).find((entry) => entry.comment === '丽莎')).toMatchObject({
        key: ['丽莎'],
        disable: false,
    });
    expect(Object.values(exported.entries).map((e) => e.content)).toEqual([
        '<legacy>旧角色原文',
        '已有角色正文',
        '生成 丽莎',
    ]);
});

it('keeps an existing selected page and treats repeated imports as a no-op for role results', async () => {
    const f = workbenchSetup(true);
    const { runner, settings } = f.create();
    await runner.importWorldbook(importedBook);
    const pages = [...f.context.chat[2].swipes];
    expect(pages).toEqual(['旧成品', '<legacy>旧角色原文', '已有角色正文']);
    expect(f.context.chat[2].mes).toBe('旧成品');
    expect(await runner.importWorldbook(importedBook)).toMatchObject({ added: 0, duplicates: 2 });
    expect(f.context.chat[2].swipes).toEqual(pages);
    expect(settings.roleBatch.names).toEqual(['琴', '安柏']);
});

it('rolls back a failed chat save without changing the list, journal or native pages', async () => {
    const f = workbenchSetup(true);
    const { runner, settings } = f.create({ roleNames: '丽莎', totalChapters: 1, roleBatch: null });
    const original = structuredClone(f.context.chat);
    f.context.saveChat.mockRejectedValueOnce(new Error('保存失败'));
    await expect(runner.importWorldbook(importedBook)).rejects.toThrow('保存失败');
    expect(f.context.chat).toEqual(original);
    expect(settings).toMatchObject({ roleNames: '丽莎', totalChapters: 1, roleBatch: null });
    expect(f.recovery.read()).toBeNull();
    expect(f.context.updateMessageBlock).not.toHaveBeenCalled();
});

it('rolls back imported chat data when the existing recovery journal cannot be saved', async () => {
    const f = workbenchSetup();
    const { runner, settings } = f.create();
    const original = structuredClone(f.context.chat);
    f.storage.setItem = () => {
        throw new Error('quota');
    };
    await expect(runner.importWorldbook(importedBook)).rejects.toMatchObject({ code: 'CHECKPOINT_FAILED' });
    expect(f.context.chat).toEqual(original);
    expect(settings.roleBatch).toBeNull();
    expect(f.context.addOneMessage).not.toHaveBeenCalled();
});

it('retains committed import records if only the native preview fails to refresh', async () => {
    const f = workbenchSetup(true);
    const { runner, settings } = f.create();
    f.context.updateMessageBlock.mockImplementationOnce(() => {
        throw new Error('preview failed');
    });
    await expect(runner.importWorldbook(importedBook)).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_FAILED' });
    expect(settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
    expect(f.recovery.read().names).toEqual(['琴', '安柏']);
    expect(f.context.chat[2].swipes).toHaveLength(3);
});
