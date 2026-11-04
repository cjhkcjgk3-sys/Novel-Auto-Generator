import { abortableDelay } from '../../txtToWorldbook/core/requestPolicy.js';
import { createRoleResultIsolation } from './resultIsolation.js';
import { hashRoleResult, RESULT_HASH_KEY } from './roleResultIntegrity.js';

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
    swipeReply = null,
} = {}) {
    let roleGeneration = null;
    let roleIsolation = null;
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
            connected: context?.onlineStatus == null ? null : context.onlineStatus !== 'no_connection',
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
        if (roleGeneration) throw new Error('上一轮酒馆生成仍在退出，请稍后再开始');
        const context = getContext();
        if (context?.groupId != null) throw new Error('请在写卡助手的单角色聊天中使用批量模式');
        if (
            ![context?.generate, context?.saveChat, context?.updateMessageBlock, swipeReply].every(
                (fn) => typeof fn === 'function',
            )
        )
            throw new Error('当前酒馆缺少原生翻页、生成或消息更新接口，请提供酒馆版本以便适配');
        const chat = getChat();
        const promptFloor = chat?.findLastIndex((message) => message?.is_user) ?? -1;
        const tail = chat?.slice(promptFloor + 1) || [];
        if (promptFloor < 0 || tail.length > 1 || tail.some((message) => message.is_user || message.is_system))
            throw new Error('请将带占位符的用户消息放在聊天末尾，其后最多保留一条 AI 回复');
        return { promptFloor, resultFloor: tail.length ? promptFloor + 1 : null, template: chat[promptFloor].mes };
    }

    async function restoreRoleTemplate(batch) {
        if (!batch || snapshot().identity !== batch.identity) return;
        if (roleGeneration) throw new Error('上一轮酒馆生成仍在退出，请稍后重置');
        if (snapshot().generating === true) throw new Error('请等待酒馆生成停止后再重置');
        const context = getContext(),
            prompt = getChat()?.[batch.promptFloor];
        if (!prompt?.is_user) return;
        if (prompt.mes.includes('[[角色名]]') && prompt.mes !== batch.template) return;
        prompt.mes = batch.template;
        if (Array.isArray(prompt.swipes)) prompt.swipes[prompt.swipe_id ?? 0] = batch.template;
        delete prompt.extra?.display_text;
        context.updateMessageBlock(batch.promptFloor, prompt);
        await context.saveChat();
    }

    async function reconcileRoleBatch(batch) {
        if (roleGeneration || snapshot().generating === true) throw new Error('酒馆仍在处理上一轮，请稍后继续');
        if (snapshot().identity !== batch.identity) throw new Error('请返回原聊天后继续任务');
        const messages = getChat();
        await roleIsolation?.verify();
        if (!messages?.[batch.promptFloor]?.is_user) throw new Error('任务对应的用户楼层已变化，请先恢复原聊天');
        if (messages.length === batch.promptFloor + 1) batch.resultFloor = null;
        else if (batch.resultFloor == null && messages.length === batch.promptFloor + 2 && !messages.at(-1)?.is_user)
            batch.resultFloor = batch.promptFloor + 1;
        const reply = batch.resultFloor == null ? null : messages[batch.resultFloor];
        if (
            messages.length !== (batch.resultFloor == null ? batch.promptFloor + 1 : batch.resultFloor + 1) ||
            reply?.is_user ||
            reply?.is_system
        )
            throw new Error('任务对应的回复楼层已变化，请先核对聊天');
        const swipes = reply?.swipes || (reply ? [reply.mes] : []);
        let changed = false;
        const updates = [];
        for (const item of [...batch.items, ...(batch.history || [])]) {
            let index = swipes.findIndex((text, swipe) => {
                const receipt = reply.swipe_info?.[swipe]?.extra?.nag_role_batch;
                return (
                    receipt?.taskId === batch.id &&
                    receipt.itemId === item.id &&
                    receipt.status === 'complete' &&
                    !!text?.trim() &&
                    text.trim() !== '...'
                );
            });
            if (
                index < 0 &&
                item.legacy &&
                item.processed &&
                !item.failed &&
                Number.isInteger(item.swipe) &&
                swipes[item.swipe]?.trim()
            ) {
                index = item.swipe;
                reply.swipe_info ??= [];
                reply.swipe_info[index] ??= {};
                reply.swipe_info[index].extra ??= {};
                const receipt = { taskId: batch.id, itemId: item.id, status: 'complete' };
                reply.swipe_info[index].extra.nag_role_batch = receipt;
                if ((reply.swipe_id ?? 0) === index) {
                    reply.extra ??= {};
                    reply.extra.nag_role_batch = receipt;
                }
                changed = true;
            }
            if (index >= 0) {
                if (!item.processed || item.failed || item.legacy) changed = true;
                updates.push([
                    item,
                    { processing: false, processed: true, failed: false, swipe: index, legacy: false },
                ]);
            } else
                updates.push([
                    item,
                    { processing: false, ...(item.processed && !item.failed ? { processed: false, swipe: null } : {}) },
                ]);
        }
        if (changed) await getContext().saveChat();
        for (const [item, update] of updates) Object.assign(item, update);
        batch.pending = false;
        batch.dispatch = null;
    }

    async function generateRoleReply(batch, text, { signal, assertCurrent, timeoutMs = 600000 }) {
        assertCurrent();
        await roleIsolation?.prepare();
        assertCurrent();
        const identity = snapshot().identity;
        const context = getContext(),
            messages = getChat();
        if (context?.onlineStatus === 'no_connection')
            throw Object.assign(new Error('酒馆 API 尚未连接，请连接后继续任务'), {
                code: 'NOT_CONNECTED',
                phase: 'dispatch',
            });
        const prompt = messages?.[batch.promptFloor];
        const expectedLength = batch.resultFloor == null ? batch.promptFloor + 1 : batch.resultFloor + 1;
        if (roleGeneration || !prompt?.is_user || messages.length !== expectedLength || snapshot().generating === true)
            throw Object.assign(new Error('聊天结构或生成状态已变化，批量任务已停止'), { uncertain: true });
        prompt.mes = text;
        if (Array.isArray(prompt.swipes)) prompt.swipes[prompt.swipe_id ?? 0] = text;
        delete prompt.extra?.display_text;
        context.updateMessageBlock(batch.promptFloor, prompt);
        await context.saveChat();
        assertCurrent();
        let reply = batch.resultFloor == null ? null : messages[batch.resultFloor];
        const previousReply = reply ? structuredClone(reply) : null;
        const expectedSwipe = reply ? Math.max(1, reply.swipes?.length || 0) : 0;
        const operation = batch.id && batch.dispatch ? { taskId: batch.id, ...batch.dispatch } : null;
        function markReceipt(status, textHash) {
            if (!operation || snapshot().identity !== identity || signal?.aborted) return;
            const message = messages[batch.resultFloor ?? batch.promptFloor + 1];
            if (!message || message.is_user || (message.swipe_id ?? 0) !== expectedSwipe) return;
            const receipt = { ...operation, status };
            message.extra ??= {};
            message.extra.nag_role_batch = receipt;
            message.swipe_info ??= [];
            message.swipe_info[expectedSwipe] ??= {};
            message.swipe_info[expectedSwipe].extra ??= {};
            message.swipe_info[expectedSwipe].extra.nag_role_batch = receipt;
            if (textHash) {
                message.extra[RESULT_HASH_KEY] = textHash;
                message.swipe_info[expectedSwipe].extra[RESULT_HASH_KEY] = textHash;
            } else if (status === 'pending') {
                delete message.extra[RESULT_HASH_KEY];
                delete message.swipe_info[expectedSwipe].extra[RESULT_HASH_KEY];
            }
        }
        async function discardEmptyReply() {
            if (!previousReply) return;
            for (const key of Object.keys(reply)) delete reply[key];
            Object.assign(reply, previousReply);
            context.updateMessageBlock(batch.resultFloor, reply);
            await context.saveChat();
        }
        const controller = new AbortController();
        const abort = () => {
            controller.abort();
            if (snapshot().identity === identity) context.stopGeneration?.();
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let timeout, watch;
        let failure;
        let rejectStopped;
        const onUserStop = () => {
            if (failure) return;
            failure = Object.assign(new Error('酒馆生成已手动停止，批量任务已结束；重置后可重新开始'), {
                uncertain: true,
                code: 'USER_STOPPED',
            });
            controller.abort();
            rejectStopped?.(failure);
        };
        const stopped = new Promise((_, reject) => {
            rejectStopped = reject;
            const fail = (error) => {
                failure = error;
                controller.abort();
                if (snapshot().identity === identity) context.stopGeneration?.();
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
        const stopEvent = context.eventTypes?.GENERATION_STOPPED;
        const startEvent = context.eventTypes?.GENERATION_STARTED;
        let started = !startEvent;
        const onStarted = (type) => {
            if (type === (reply ? 'swipe' : 'regenerate')) {
                started = true;
                markReceipt('pending');
            }
        };
        const receivedEvent = context.eventTypes?.MESSAGE_RECEIVED;
        const onReceived = async (floor) => {
            if (failure || floor !== (batch.resultFloor ?? batch.promptFloor + 1)) return;
            const processor = getContext()?.streamingProcessor;
            const text = String(messages[floor]?.mes || '');
            if (text.trim() && text.trim() !== '...' && (!processor || (processor.isFinished && !processor.isStopped)))
                markReceipt('complete', roleIsolation?.active() ? await hashRoleResult(text) : undefined);
        };
        if (stopEvent) context.eventSource?.on(stopEvent, onUserStop);
        if (startEvent) context.eventSource?.on(startEvent, onStarted);
        if (receivedEvent) context.eventSource?.on(receivedEvent, onReceived);
        try {
            // regenerate on a user tail neither adds a user message nor consumes the input draft.
            // swipe excludes the result floor while retaining presets, card fields and worldbook rules.
            const generation = (async () => {
                assertCurrent();
                // Native swipe owns page selection, UI updates and MESSAGE_SWIPED notifications.
                // Do not pass our signal: core uses its presence to reuse an older abort controller.
                if (reply) await swipeReply(batch.resultFloor, expectedSwipe);
                else await context.generate('regenerate');
                // Some host integrations return before their streaming task has settled.
                while (snapshot().generating === true) {
                    assertCurrent();
                    await abortableDelay(100, controller.signal);
                }
            })();
            roleGeneration = generation;
            const release = () => {
                if (roleGeneration === generation) roleGeneration = null;
            };
            generation.then(release, release);
            await Promise.race([generation, stopped]);
            if (failure) throw failure;
            assertCurrent();
            if (!started)
                throw Object.assign(new Error('酒馆没有启动本轮生成，请下载错误日志'), {
                    code: 'NOT_STARTED',
                    phase: 'dispatch',
                    expectedSwipe,
                    actualSwipe: reply?.swipe_id,
                });
            if (batch.resultFloor == null && messages.length === batch.promptFloor + 2)
                batch.resultFloor = batch.promptFloor + 1;
            reply = messages[batch.resultFloor];
            if (!reply || reply.is_user) return { text: '', swipe: null, truncated: false };
            if (messages.length !== batch.resultFloor + 1 || reply.swipe_id !== expectedSwipe)
                throw Object.assign(new Error('酒馆未切换到本轮候选页，已停止；请下载错误日志'), {
                    uncertain: true,
                    phase: 'select-swipe',
                    expectedSwipe,
                    actualSwipe: reply.swipe_id,
                });
            // Core streaming failures can resolve normally and leave the initial "..." in chat.
            await roleIsolation?.verify();
            const text = String(reply.mes || '');
            if (!text.trim() || text.trim() === '...') {
                const notice = getDocument().querySelector('#toast-container .toast-error .toast-message')?.textContent;
                const error = Object.assign(new Error(notice || '酒馆没有返回正文'), {
                    code: 'EMPTY_REPLY',
                    phase: 'read-reply',
                    expectedSwipe,
                    actualSwipe: reply.swipe_id,
                });
                await discardEmptyReply();
                return { text: '', swipe: null, truncated: false, error };
            }
            const processor = getContext()?.streamingProcessor;
            const isStreamInterrupted = Boolean(processor && (!processor.isFinished || processor.isStopped));
            markReceipt(
                isStreamInterrupted ? 'partial' : 'complete',
                roleIsolation?.active() ? await hashRoleResult(text) : undefined,
            );
            await context.saveChat();
            return { text, swipe: reply.swipe_id, truncated: isStreamInterrupted };
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
            if (stopEvent) context.eventSource?.removeListener(stopEvent, onUserStop);
            if (startEvent) context.eventSource?.removeListener(startEvent, onStarted);
            if (receivedEvent) context.eventSource?.removeListener(receivedEvent, onReceived);
            // Let core finish its swipe cleanup before reset can dispatch another generation.
            if (roleGeneration) await Promise.race([roleGeneration.catch(() => {}), abortableDelay(1000)]);
        }
    }
    return {
        getChat,
        async restoreLegacyVisibility() {
            let changed = false;
            for (const message of getChat() || []) {
                if (message?._nag_hidden) {
                    delete message.is_hidden;
                    delete message._nag_hidden;
                    changed = true;
                }
            }
            if (changed) await getContext().saveChat();
        },
        createRoleResultIsolation(options) {
            roleIsolation?.dispose();
            roleIsolation = createRoleResultIsolation({ getContext, getChat, snapshot, getDocument, ...options });
            return roleIsolation;
        },
        snapshot,
        send,
        prepareRoleBatch,
        generateRoleReply,
        restoreRoleTemplate,
        reconcileRoleBatch,
        async confirmRoleRestart() {
            return !!(await getContext().Popup.show.confirm(
                '从头生成全部角色',
                '将清除完成进度并从名单第一项重新生成；已有候选回复仍然保留。是否继续？',
            ));
        },
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
