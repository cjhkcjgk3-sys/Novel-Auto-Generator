import { abortableDelay } from '../../txtToWorldbook/core/requestPolicy.js';

export function getSillyTavernContext() {
    return globalThis.SillyTavern?.getContext?.() ?? globalThis.getContext?.() ?? null;
}

/** All host reads are live, so a chat switch is checked immediately before dispatch. */
export function createSillyTavernHost({
    getContext = getSillyTavernContext,
    getLegacyChat = () => globalThis.chat,
    getDocument = () => globalThis.document,
    getStyle = (element) => globalThis.getComputedStyle(element),
    jquery = (...args) => globalThis.jQuery(...args),
    extensionSettings = {},
    saveSettings = () => {},
} = {}) {
    function getChat() {
        try {
            const chat = getContext()?.chat;
            if (Array.isArray(chat)) return chat;
        } catch {}
        const legacy = getLegacyChat();
        return Array.isArray(legacy) ? legacy : null;
    }
    function snapshot() {
        const context = getContext();
        const chat = getChat();
        const chatId = context?.chatId ?? context?.getCurrentChatId?.();
        const identity = chatId != null ? String(context?.groupId ?? context?.characterId ?? '') + ':' + chatId : chat;
        const document = getDocument();
        const stop = document.querySelector('#mes_stop');
        return {
            identity,
            messages: (chat || []).filter(Boolean).map((message) => ({
                isUser: Boolean(message.is_user || message.is_human),
                isSystem: Boolean(message.is_system),
                text: String(message.mes || ''),
            })),
            generating: stop ? getStyle(stop).display !== 'none' : null,
            toast: Boolean(document.querySelector('#toast-container .toast')),
        };
    }
    async function send(text, { signal, assertCurrent }) {
        assertCurrent();
        const input = jquery('#send_textarea'),
            button = jquery('#send_but');
        if (!input.length || !button.length || button.prop('disabled'))
            throw Object.assign(new Error('发送控件尚未就绪，请稍后重试'), { dispatched: false });
        input.val(text);
        input[0].value = text;
        input.trigger('input').trigger('change');
        await abortableDelay(100, signal);
        assertCurrent();
        if (button.prop('disabled')) throw Object.assign(new Error('发送控件已禁用'), { dispatched: false });
        button.trigger('click');
    }

    function prepareRoleBatch() {
        const context = getContext();
        if (context?.groupId != null) throw new Error('请在写卡助手的单角色聊天中使用批量模式');
        if (
            ![context?.generate, context?.saveChat, context?.updateMessageBlock].every((fn) => typeof fn === 'function')
        )
            throw new Error('当前酒馆缺少生成或消息更新接口，请更新酒馆后重试');
        const chat = getChat();
        const promptFloor = chat?.findLastIndex((message) => message?.is_user) ?? -1;
        const tail = chat?.slice(promptFloor + 1) || [];
        if (promptFloor < 0 || tail.length > 1 || tail.some((message) => message.is_user || message.is_system))
            throw new Error('请将带占位符的用户消息放在聊天末尾，其后最多保留一条 AI 回复');
        return { promptFloor, resultFloor: tail.length ? promptFloor + 1 : null, template: chat[promptFloor].mes };
    }

    async function restoreRoleTemplate(batch) {
        if (!batch || snapshot().identity !== batch.identity) return;
        if (snapshot().generating === true) throw new Error('请等待酒馆生成停止后再重置');
        const context = getContext(),
            prompt = getChat()?.[batch.promptFloor];
        if (!prompt?.is_user) return;
        prompt.mes = batch.template;
        if (Array.isArray(prompt.swipes)) prompt.swipes[prompt.swipe_id ?? 0] = batch.template;
        delete prompt.extra?.display_text;
        context.updateMessageBlock(batch.promptFloor, prompt);
        await context.saveChat();
    }

    async function generateRoleReply(batch, text, { signal, assertCurrent, timeoutMs = 600000 }) {
        assertCurrent();
        const identity = snapshot().identity;
        const context = getContext(),
            messages = getChat();
        const prompt = messages?.[batch.promptFloor];
        const expectedLength = batch.resultFloor == null ? batch.promptFloor + 1 : batch.resultFloor + 1;
        if (!prompt?.is_user || messages.length !== expectedLength || snapshot().generating === true)
            throw Object.assign(new Error('聊天结构或生成状态已变化，批量任务已停止'), { uncertain: true });
        prompt.mes = text;
        if (Array.isArray(prompt.swipes)) prompt.swipes[prompt.swipe_id ?? 0] = text;
        delete prompt.extra?.display_text;
        context.updateMessageBlock(batch.promptFloor, prompt);
        await context.saveChat();
        assertCurrent();
        let reply = batch.resultFloor == null ? null : messages[batch.resultFloor];
        const previousReply = reply ? structuredClone(reply) : null;
        let expectedSwipe = 0;
        if (reply) {
            // Match native swipe preparation: archive the selected page, then select a new slot.
            reply.swipes ??= [reply.mes];
            reply.swipe_info ??= [];
            const previous = reply.swipe_id ?? 0;
            reply.swipes[previous] = reply.mes;
            reply.swipe_info[previous] = {
                send_date: reply.send_date,
                gen_started: reply.gen_started,
                gen_finished: reply.gen_finished,
                extra: structuredClone(reply.extra || {}),
            };
            expectedSwipe = reply.swipes.length;
            reply.swipe_id = expectedSwipe;
            reply.mes = '';
            reply.extra = {};
        }
        async function discardEmptyReply() {
            if (!previousReply) return;
            for (const key of Object.keys(reply)) delete reply[key];
            Object.assign(reply, previousReply);
            context.updateMessageBlock(batch.resultFloor, reply);
            await context.saveChat();
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let timeout, watch;
        let failure;
        const stopped = new Promise((_, reject) => {
            const fail = (error) => {
                failure = error;
                controller.abort();
                reject(error);
            };
            timeout = setTimeout(
                () => fail(Object.assign(new Error('生成超时，请确认酒馆已停止后再处理'), { uncertain: true })),
                timeoutMs,
            );
            watch = setInterval(() => {
                try {
                    assertCurrent();
                } catch (error) {
                    fail(error);
                }
            }, 100);
        });
        try {
            // regenerate on a user tail neither adds a user message nor consumes the input draft.
            // swipe excludes the result floor while retaining presets, card fields and worldbook rules.
            await Promise.race([
                (async () => {
                    await context.generate(reply ? 'swipe' : 'regenerate', { signal: controller.signal });
                    // Some host integrations return before their streaming task has settled.
                    while (snapshot().generating === true) {
                        assertCurrent();
                        await abortableDelay(100, controller.signal);
                    }
                })(),
                stopped,
            ]);
            if (failure) throw failure;
            assertCurrent();
            if (batch.resultFloor == null && messages.length === batch.promptFloor + 2)
                batch.resultFloor = batch.promptFloor + 1;
            reply = messages[batch.resultFloor];
            if (!reply || reply.is_user) return { text: '', swipe: null, truncated: false };
            if (messages.length !== batch.resultFloor + 1 || reply.swipe_id !== expectedSwipe)
                throw Object.assign(new Error('回复楼层或候选页已变化，请手动核对结果'), { uncertain: true });
            // Core streaming failures can resolve normally and leave the initial "..." in chat.
            const text = String(reply.mes || '');
            if (!text.trim() || text.trim() === '...') {
                await discardEmptyReply();
                return { text: '', swipe: null, truncated: false };
            }
            await context.saveChat();
            return { text, swipe: reply.swipe_id, truncated: !!getContext()?.streamingProcessor?.isStopped };
        } catch (error) {
            if (failure) throw failure;
            if (batch.resultFloor == null && messages.length === batch.promptFloor + 2 && !messages.at(-1)?.is_user)
                batch.resultFloor = batch.promptFloor + 1;
            reply = messages[batch.resultFloor];
            if (error.code === 'TOKEN_LIMIT') return { text: reply?.mes || '', swipe: expectedSwipe, truncated: true };
            if (
                !error.uncertain &&
                !signal?.aborted &&
                snapshot().identity === identity &&
                snapshot().generating !== true &&
                messages === getChat() &&
                reply?.swipe_id === expectedSwipe
            )
                await discardEmptyReply();
            throw error;
        } finally {
            clearTimeout(timeout);
            clearInterval(watch);
            signal?.removeEventListener('abort', abort);
        }
    }
    return {
        getChat,
        snapshot,
        send,
        prepareRoleBatch,
        generateRoleReply,
        restoreRoleTemplate,
        readSettings(name) {
            return extensionSettings[name] || {};
        },
        writeSettings(name, value) {
            extensionSettings[name] ??= {};
            Object.assign(extensionSettings[name], value);
            saveSettings();
        },
    };
}
