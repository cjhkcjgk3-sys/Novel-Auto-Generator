import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import {
    createRoleResultIsolation,
    ROLE_BATCH_REQUEST,
    ROLE_RESULT_INTERCEPTOR,
} from '../../src/host/resultIsolation.js';
import { verifyRoleResults, clearRoleResultHashes } from '../../src/host/roleResultIntegrity.js';
import { createSillyTavernHost } from '../../src/host/sillyTavern.js';

const instances = [];
afterEach(() => {
    instances.splice(0).forEach((instance) => instance.dispose());
    vi.unstubAllGlobals();
});

function setup(count = 1) {
    const source = new EventEmitter();
    source.makeFirst = source.prependListener;
    const context = {
        eventSource: source,
        eventTypes: { CHARACTER_MESSAGE_RENDERED: 'rendered', MESSAGE_SWIPED: 'swiped', CHAT_CHANGED: 'changed' },
        saveChat: vi.fn(async () => {}),
        updateMessageBlock: vi.fn(),
    };
    const message = {
        is_user: false,
        extra: {},
        mes: '结果0',
        swipe_id: 0,
        swipes: Array.from({ length: count }, (_, index) => `结果${index}`),
        swipe_info: Array.from({ length: count }, () => ({ extra: {} })),
    };
    const chat = [
        { is_user: false, mes: '上方工作界面', extra: {} },
        { is_user: true, mes: '生成命令', extra: {} },
        message,
    ];
    const batch = { identity: 'chat-a', promptFloor: 1, resultFloor: 2 };
    let enabled = true,
        identity = 'chat-a';
    const onError = vi.fn();
    const isolation = createRoleResultIsolation({
        getContext: () => context,
        getChat: () => chat,
        getDocument: () => null,
        getBatch: () => (enabled ? batch : null),
        snapshot: () => ({ identity }),
        onError,
    });
    instances.push(isolation);
    return {
        isolation,
        chat,
        message,
        source,
        context,
        onError,
        disable: () => {
            enabled = false;
        },
        switchChat: () => {
            identity = 'chat-b';
        },
    };
}

it('removes only the copied result message, preserving upper history and the command even with identical text', async () => {
    const f = setup();
    f.chat[1].mes = f.message.mes;
    const originals = structuredClone(f.chat);
    const prompt = f.chat.map((message, index) => ({ ...message, index }));
    const abort = vi.fn();
    await globalThis[ROLE_RESULT_INTERCEPTOR](prompt, 10000, abort);
    expect(prompt.map((message) => message.extra)).toEqual([f.chat[0].extra, f.chat[1].extra]);
    expect(f.chat).toEqual(originals);
    expect(abort).not.toHaveBeenCalled();
});

it('recognizes receipt identity after another extension clones prompt messages', async () => {
    const f = setup();
    f.message.extra.nag_role_batch = { taskId: 'task', itemId: 'item', attemptId: 'attempt' };
    const prompt = structuredClone(f.chat);
    await globalThis[ROLE_RESULT_INTERCEPTOR](prompt, 10000, vi.fn());
    expect(prompt.map((message) => message.mes)).toEqual(['上方工作界面', '生成命令']);
});

it('does not filter any message when disabled or viewing a different chat', async () => {
    for (const change of ['disable', 'switchChat']) {
        const f = setup();
        f[change]();
        const prompt = f.chat.map((message) => ({ ...message }));
        await globalThis[ROLE_RESULT_INTERCEPTOR](prompt, 10000, vi.fn());
        expect(prompt).toHaveLength(3);
    }
});

it.each([50, 100])(
    'seals %i native swipes without storing result copies or growing event subscriptions',
    async (count) => {
        const f = setup(count);
        const bodies = [...f.message.swipes];
        const listeners = () => f.source.eventNames().reduce((sum, event) => sum + f.source.listenerCount(event), 0);
        const before = listeners();
        await f.isolation.prepare();
        for (let index = 0; index < 5; index++) await f.isolation.prepare();
        expect(f.message.swipes).toEqual(bodies);
        expect(f.message.swipe_info.every((info) => typeof info.extra.nag_result_hash === 'string')).toBe(true);
        expect(listeners()).toBe(before);
        expect(f.context.saveChat).toHaveBeenCalledTimes(1);
        f.isolation.dispose();
        expect(listeners()).toBe(0);
        expect(globalThis[ROLE_RESULT_INTERCEPTOR]).toBeUndefined();
    },
);

it('detects a changed old swipe and aborts the prompt before sending it', async () => {
    const f = setup(50);
    await f.isolation.prepare();
    f.message.swipes[12] = '其他插件修改过的原文';
    const abort = vi.fn();
    await globalThis[ROLE_RESULT_INTERCEPTOR](
        f.chat.map((message) => ({ ...message })),
        10000,
        abort,
    );
    expect(abort).toHaveBeenCalledWith(true);
    expect(f.onError.mock.calls[0][0]).toMatchObject({ code: 'RESULT_CHANGED', expectedSwipe: 12 });
});

it('detects changes to the selected message even if its backing swipe was left untouched', async () => {
    const f = setup();
    await f.isolation.prepare();
    f.message.mes = '改动';
    await expect(f.isolation.verify()).rejects.toMatchObject({ code: 'RESULT_CHANGED' });
});

it('allows a native swipe switch during hashing without reporting an unchanged body as modified', async () => {
    const f = setup(3);
    await f.isolation.prepare();
    let finish;
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.stubGlobal('crypto', {
        subtle: {
            digest: vi.fn(digest).mockImplementationOnce(
                (...args) =>
                    new Promise((resolve) => {
                        finish = async () => resolve(await digest(...args));
                    }),
            ),
        },
    });
    const checking = f.isolation.verify();
    f.message.swipes = [...f.message.swipes];
    f.message.swipe_id = 1;
    f.message.mes = f.message.swipes[1];
    f.message.extra = structuredClone(f.message.swipe_info[1].extra);
    await finish();
    await expect(checking).resolves.toBeUndefined();
    f.message.swipes[0] += ' unexpected change';
    await expect(f.isolation.verify()).rejects.toMatchObject({ code: 'RESULT_CHANGED', expectedSwipe: 0 });
});

it('keeps rendering native and reports a moving three-page preview window, including a pending new page', async () => {
    const f = setup(100);
    const rendered = vi.fn();
    f.source.on('rendered', rendered);
    await f.isolation.prepare();
    expect(rendered).not.toHaveBeenCalled();
    expect(f.context.updateMessageBlock).not.toHaveBeenCalled();
    expect(f.isolation.previewWindow()).toEqual([0, 1]);
    f.message.swipe_id = 49;
    expect(f.isolation.previewWindow()).toEqual([48, 49, 50]);
    f.message.swipe_id = 99;
    expect(f.isolation.previewWindow()).toEqual([98, 99]);
    f.message.swipe_id = 100;
    expect(f.isolation.previewWindow()).toEqual([99, 100]);
});

it('still excludes the copied result if native swiping replaces its metadata while the interceptor is hashing', async () => {
    const f = setup(3);
    await f.isolation.prepare();
    let finish;
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.stubGlobal('crypto', {
        subtle: {
            digest: vi.fn(digest).mockImplementationOnce(
                (...args) =>
                    new Promise((resolve) => {
                        finish = async () => resolve(await digest(...args));
                    }),
            ),
        },
    });
    const prompt = f.chat.map((message) => ({ ...message }));
    const abort = vi.fn();
    const checking = globalThis[ROLE_RESULT_INTERCEPTOR](prompt, 10000, abort);
    f.message.swipe_id = 1;
    f.message.mes = f.message.swipes[1];
    f.message.extra = structuredClone(f.message.swipe_info[1].extra);
    await finish();
    await checking;
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.map((message) => message.mes)).toEqual(['上方工作界面', '生成命令']);
});

it('allows a deliberate new baseline after disabling protection, retaining all text', async () => {
    const f = setup();
    await f.isolation.prepare();
    await f.isolation.resetProtection();
    f.message.mes = f.message.swipes[0] = '用户主动编辑';
    await f.isolation.prepare();
    await expect(f.isolation.verify()).resolves.toBeUndefined();
    expect(f.message.mes).toBe('用户主动编辑');
});

it('does not save protection metadata into another chat when it changes during hashing', async () => {
    let finish;
    vi.stubGlobal('crypto', {
        subtle: {
            digest: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        },
    });
    const f = setup();
    const pending = f.isolation.prepare();
    f.switchChat();
    finish(new Uint8Array(32).buffer);
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.context.saveChat).not.toHaveBeenCalled();
    expect(f.message.swipe_info[0].extra).toEqual({});
});

it('does not render the old floor in a new chat if it changes while metadata is saving', async () => {
    const f = setup();
    const rendered = vi.fn();
    f.source.on('rendered', rendered);
    f.context.saveChat.mockImplementation(async () => f.switchChat());
    await expect(f.isolation.prepare()).rejects.toMatchObject({ code: 'ABORTED' });
    expect(rendered).not.toHaveBeenCalled();
});

it('checks the full text in the non-WebCrypto fallback and restores no foreign metadata', async () => {
    vi.stubGlobal('crypto', undefined);
    const message = { mes: '长'.repeat(120000), extra: {}, swipe_id: 0 };
    message.swipes = [message.mes];
    await verifyRoleResults(message, { seal: true });
    message.mes = message.swipes[0] = message.mes.slice(0, 30000) + '改' + message.mes.slice(30001);
    await expect(verifyRoleResults(message)).rejects.toMatchObject({ code: 'RESULT_CHANGED' });
    message.extra.foreign = '保留';
    clearRoleResultHashes(message);
    expect(message.extra).toEqual({ foreign: '保留' });
});

it('migrates only visibility flags owned by the earlier plugin, preserving native hidden messages', async () => {
    const chat = [
        { mes: '旧标记', _nag_hidden: true, is_hidden: true },
        { mes: '用户隐藏', is_system: true },
    ];
    const context = { chat, saveChat: vi.fn(async () => {}) };
    const host = createSillyTavernHost({ getContext: () => context });
    await host.restoreLegacyVisibility();
    expect(chat).toEqual([{ mes: '旧标记' }, { mes: '用户隐藏', is_system: true }]);
    expect(context.saveChat).toHaveBeenCalledTimes(1);
});

function imageSetup({ canInline, exists = true } = {}) {
    const onImageSkipped = vi.fn();
    const mediaApi = {
        getMediaDisplay: () => 'list',
        getMediaIndex: () => 0,
        MEDIA_DISPLAY: { LIST: 'list', GALLERY: 'gallery' },
        MEDIA_SOURCE: { UPLOAD: 'upload' },
        MEDIA_TYPE: { IMAGE: 'image' },
        canInlineImages: canInline === undefined ? undefined : () => canInline,
        imageExists: vi.fn(async () => exists),
    };
    const isolation = createRoleResultIsolation({
        getContext: () => ({}),
        getChat: () => [],
        getDocument: () => null,
        getBatch: () => null,
        snapshot: () => ({ identity: 'chat-a' }),
        getRoleImage: () => ({ name: '安比', fileName: '安比', path: '/user/images/x/a.webp' }),
        mediaApi,
        onImageSkipped,
    });
    instances.push(isolation);
    const marker = { taskId: 'batch', itemId: 'role0', attemptId: 'a1' };
    const request = { is_user: true, mes: '生成 安比', extra: { [ROLE_BATCH_REQUEST]: marker } };
    return { isolation, request, marker, onImageSkipped, mediaApi };
}

it('adds the matched role image to the request copy when the host can send it', async () => {
    const f = imageSetup({ canInline: true });
    await globalThis[ROLE_RESULT_INTERCEPTOR]([f.request], 0, vi.fn());
    expect(f.request.extra.media).toEqual([
        { url: '/user/images/x/a.webp', type: 'image', title: '安比', source: 'upload' },
    ]);
    expect(f.request.extra[ROLE_BATCH_REQUEST]).toBeUndefined();
    expect(f.onImageSkipped).not.toHaveBeenCalled();
});

it('reports, without attaching, a matched image the host would silently drop', async () => {
    const off = imageSetup({ canInline: false });
    await globalThis[ROLE_RESULT_INTERCEPTOR]([off.request], 0, vi.fn());
    expect(off.request.extra.media).toBeUndefined();
    expect(off.onImageSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'batch', reason: expect.stringContaining('发送内嵌图片') }),
    );
    const missing = imageSetup({ canInline: true, exists: false });
    await globalThis[ROLE_RESULT_INTERCEPTOR]([missing.request], 0, vi.fn());
    expect(missing.request.extra.media).toBeUndefined();
    expect(missing.onImageSkipped.mock.calls[0][0].reason).toContain('图片文件不存在');
});
