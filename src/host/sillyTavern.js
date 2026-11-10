import { abortableDelay } from '../../txtToWorldbook/core/requestPolicy.js';
import { isRoleCardTruncated } from '../novel/tagFilters.js';
import { createRoleResultIsolation } from './resultIsolation.js';
import { hashRoleResult, RESULT_HASH_KEY } from './roleResultIntegrity.js';
import {
    ROLE_ENTRY_KEY,
    ROLE_WORLDBOOK_KEY,
    writeRoleWorldbook,
    wrapCodeFence,
    unwrapCodeFence,
} from '../novel/roleWorldbook.js';
import { countUnidentifiedRolePages, roleComplete } from '../novel/roleBatchState.js';
import { selectedRole } from './roleSelection.js';
import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';

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
    syncMesToSwipe = null,
    syncSwipeToMes = null,
    readSavedChat = null,
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
        if (
            Array.isArray(batch.items) &&
            prompt.mes !== batch.template &&
            ![...batch.items, ...(batch.history || [])].some(
                (item) => item.name && batch.template.replaceAll('[[角色名]]', () => item.name) === prompt.mes,
            )
        )
            return;
        prompt.mes = batch.template;
        if (Array.isArray(prompt.swipes)) prompt.swipes[prompt.swipe_id ?? 0] = batch.template;
        delete prompt.extra?.display_text;
        context.updateMessageBlock(batch.promptFloor, prompt);
        await context.saveChat();
    }

    async function reconcileRoleBatch(batch, validationOptions = {}) {
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
            const pendingAttempt =
                batch.pending && batch.dispatch?.itemId === item.id ? batch.dispatch.attemptId : null;
            const matching = (text, swipe) => {
                const receipt = reply?.swipe_info?.[swipe]?.extra?.nag_role_batch;
                return (
                    receipt?.taskId === batch.id &&
                    receipt.itemId === item.id &&
                    !receipt.previewId &&
                    receipt.status === 'complete' &&
                    !!text?.trim() &&
                    text.trim() !== '...' &&
                    (receipt.origin === 'worldbook' || !isRoleCardTruncated(text, validationOptions))
                );
            };
            const completedAttempt = pendingAttempt
                ? swipes.findLastIndex(
                      (text, swipe) =>
                          matching(text, swipe) &&
                          reply.swipe_info?.[swipe]?.extra?.nag_role_batch?.attemptId === pendingAttempt,
                  )
                : -1;
            if (item.manualStatus === 'failed' && completedAttempt < 0) {
                updates.push([item, { processing: false, processed: true, failed: true }]);
                continue;
            }
            if (item.manualStatus === 'complete') {
                const bound = swipes.findLastIndex((text, swipe) => {
                    const receipt = reply.swipe_info?.[swipe]?.extra?.nag_role_batch;
                    return (
                        receipt?.taskId === batch.id &&
                        receipt.itemId === item.id &&
                        !receipt.previewId &&
                        !!text?.trim() &&
                        text.trim() !== '...'
                    );
                });
                const legacy = item.legacy && Number.isInteger(item.swipe) && swipes[item.swipe]?.trim();
                updates.push([
                    item,
                    {
                        processing: false,
                        processed: true,
                        failed: false,
                        swipe: bound >= 0 ? bound : legacy ? item.swipe : null,
                    },
                ]);
                continue;
            }
            let index =
                completedAttempt >= 0
                    ? completedAttempt
                    : Number.isInteger(item.swipe) && matching(swipes[item.swipe], item.swipe)
                      ? item.swipe
                      : swipes.findLastIndex(matching);
            if (
                index < 0 &&
                item.legacy &&
                item.processed &&
                !item.failed &&
                Number.isInteger(item.swipe) &&
                swipes[item.swipe]?.trim() &&
                !isRoleCardTruncated(swipes[item.swipe], validationOptions)
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
                    {
                        processing: false,
                        processed: true,
                        failed: false,
                        swipe: index,
                        legacy: false,
                        ...(completedAttempt >= 0 ? { manualStatus: null } : {}),
                    },
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

    async function importRoleResults(batch, imported, commit) {
        const context = getContext(),
            messages = getChat();
        const assertCurrent = () => {
            if (snapshot().identity !== batch.identity || messages !== getChat())
                throw new Error('导入期间聊天已切换，请返回原聊天后重试');
            if (roleGeneration || snapshot().generating === true) throw new Error('请先等待酒馆生成结束');
        };
        assertCurrent();
        await roleIsolation?.verify();
        const floor = batch.resultFloor ?? batch.promptFloor + 1;
        const previous = messages[floor];
        if (messages.length !== floor + (previous ? 1 : 0) || previous?.is_user || previous?.is_system)
            throw new Error('任务对应的回复楼层已变化，请先核对聊天');
        if (!previous && typeof context.addOneMessage !== 'function')
            throw new Error('当前酒馆缺少消息显示接口，无法导入备选回复');
        const draft = previous
            ? structuredClone(previous)
            : {
                  name: context.name2 || '角色成果',
                  is_user: false,
                  is_system: false,
                  send_date: new Date().toISOString(),
                  mes: '',
                  swipe_id: 0,
                  swipes: [],
                  swipe_info: [],
                  extra: {},
              };
        draft.swipes ??= [draft.mes];
        draft.swipe_info ??= [];
        const selected = draft.swipe_id ?? 0;
        if (previous) {
            draft.swipes[selected] = draft.mes;
            draft.swipe_info[selected] = { ...draft.swipe_info[selected], extra: structuredClone(draft.extra || {}) };
        }
        for (const role of imported.roles) {
            const swipe = draft.swipes.length;
            const entry = structuredClone(role.entry);
            delete entry.content;
            // 备选页里放代码块形态，酒馆助手才能渲染成窗口；世界书里的数据仍是干净正文。
            const swipeText = wrapCodeFence(role.text);
            const extra = {
                nag_role_batch: { taskId: batch.id, itemId: role.item.id, status: 'complete', origin: 'worldbook' },
                [ROLE_ENTRY_KEY]: entry,
                [RESULT_HASH_KEY]: await hashRoleResult(swipeText),
            };
            assertCurrent();
            draft.swipes.push(swipeText);
            draft.swipe_info.push({ send_date: draft.send_date, extra });
            Object.assign(role.item, {
                processed: true,
                failed: false,
                manualStatus: null,
                processing: false,
                legacy: false,
                swipe,
                origin: 'worldbook',
            });
        }
        const source = (draft[ROLE_WORLDBOOK_KEY] ??= {
            metadata: imported.metadata,
            entriesAsArray: imported.entriesAsArray,
            retained: [],
        });
        const retained = new Set(source.retained.map((entry) => JSON.stringify(entry)));
        for (const entry of imported.retained) {
            const key = JSON.stringify(entry);
            if (!retained.has(key)) {
                source.retained.push(structuredClone(entry));
                retained.add(key);
            }
        }
        draft.mes = draft.swipes[selected];
        draft.extra = structuredClone(draft.swipe_info[selected]?.extra || {});
        draft.swipe_id = selected;
        assertCurrent();
        batch.resultFloor = floor;
        if (previous) messages[floor] = draft;
        else messages.push(draft);
        try {
            await context.saveChat();
            commit();
        } catch (error) {
            if (messages[floor] === draft) {
                if (previous) messages[floor] = previous;
                else messages.splice(floor, 1);
                if (snapshot().identity === batch.identity) {
                    try {
                        await context.saveChat();
                    } catch {
                        throw Object.assign(new Error('导入保存失败，恢复保存也未成功；请保留当前页面并下载错误日志'), {
                            code: 'IMPORT_ROLLBACK_FAILED',
                            uncertain: true,
                        });
                    }
                }
            }
            throw error;
        }
        if (snapshot().identity === batch.identity) {
            try {
                if (previous) context.updateMessageBlock(floor, draft);
                else context.addOneMessage(draft);
            } catch {
                throw Object.assign(new Error('角色已导入并保存，预览刷新失败；请刷新酒馆后查看'), {
                    code: 'IMPORT_PREVIEW_FAILED',
                });
            }
        }
    }

    function exportRoleWorldbook(batch) {
        if (snapshot().identity !== batch.identity || snapshot().generating === true)
            throw new Error('请返回原聊天，并等待生成结束后导出');
        const reply = getChat()?.[batch.resultFloor];
        if (!reply) throw new Error('没有角色成果可导出');
        const results = [...batch.items, ...(batch.history || [])]
            .filter(roleComplete)
            .map((item) => ({
                name: item.name,
                text: unwrapCodeFence(item.swipe === (reply.swipe_id ?? 0) ? reply.mes : reply.swipes?.[item.swipe]),
                entry: reply.swipe_info?.[item.swipe]?.extra?.[ROLE_ENTRY_KEY]
                    ? reply.swipe_info[item.swipe].extra[ROLE_ENTRY_KEY]
                    : undefined,
            }))
            .filter((result) => typeof result.text === 'string' && result.text.trim());
        return writeRoleWorldbook(results, reply[ROLE_WORLDBOOK_KEY]);
    }

    async function restoreRoleTemplateIfEquals(batch, expected) {
        if (!batch || snapshot().identity !== batch.identity || getChat()?.[batch.promptFloor]?.mes !== expected)
            return false;
        await restoreRoleTemplate(batch);
        return true;
    }

    function readRoleTemplate(batch) {
        if (!batch || snapshot().identity !== batch.identity) throw new Error('请返回原聊天后修改提示词');
        if (roleGeneration || snapshot().generating === true) throw new Error('请等待酒馆生成结束后修改提示词');
        const prompt = getChat()?.[batch.promptFloor];
        if (!prompt?.is_user || typeof prompt.mes !== 'string') throw new Error('任务对应的用户提示词楼层已变化');
        return prompt.mes;
    }

    async function captureRoleReroll(batch) {
        if (roleGeneration || snapshot().generating === true) throw new Error('请先等待当前生成结束');
        if (![syncMesToSwipe, syncSwipeToMes, readSavedChat].every((fn) => typeof fn === 'function'))
            throw new Error('当前酒馆缺少安全核对备选回复所需的接口');
        if (snapshot().identity !== batch.identity) throw new Error('请回到原聊天后重试');
        const chat = getChat(),
            message = chat?.[batch.resultFloor];
        if (chat?.length !== batch.resultFloor + 1) throw new Error('回复楼层已经变化，无法安全重生成');
        if (!chat[batch.promptFloor]?.is_user || chat[batch.promptFloor].mes !== batch.template)
            throw new Error('原始提示词已变化，请先核对聊天和批次模板');
        const selected = selectedRole(batch, message);
        if (!selected) throw new Error('当前备选页没有可靠的角色记录，无法安全重生成');
        if (!syncMesToSwipe(batch.resultFloor)) throw new Error('当前备选页无法同步，请先检查聊天');
        const assertSelection = () => {
            const current = selectedRole(batch, message);
            if (
                snapshot().identity !== batch.identity ||
                getChat()?.[batch.resultFloor] !== message ||
                current?.index !== selected.index ||
                current?.item.id !== selected.item.id ||
                getChat()?.[batch.promptFloor]?.mes !== batch.template
            )
                throw new Error('预备期间聊天、提示词或备选页已变化，未开始重生成');
        };
        // Seal unhashed pages now, otherwise prepare() in generateRoleReply mutates swipe_info after the baseline.
        await roleIsolation?.prepare();
        assertSelection();
        // A reverted overswipe can leave a stale pending swipe_info entry past the last swipe.
        if (Array.isArray(message.swipe_info) && message.swipe_info.length > message.swipes.length)
            message.swipe_info.length = message.swipes.length;
        const baseline = structuredClone(message);
        await getContext().saveChat();
        const saved = await readSavedChat(getContext());
        assertSelection();
        if (
            JSON.stringify(message.swipes) !== JSON.stringify(baseline.swipes) ||
            JSON.stringify(message.swipe_info) !== JSON.stringify(baseline.swipe_info)
        )
            throw new Error('预备期间备选回复已变化，未开始重生成');
        if (
            JSON.stringify(saved[batch.resultFloor]?.swipes) !== JSON.stringify(baseline.swipes) ||
            JSON.stringify(saved[batch.resultFloor]?.swipe_info) !== JSON.stringify(baseline.swipe_info)
        )
            throw new Error('原有备选回复未能确认保存，请检查酒馆保存状态后重试');
        return {
            identity: batch.identity,
            floor: batch.resultFloor,
            itemId: selected.item.id,
            name: selected.item.name,
            index: selected.index,
            baseline,
        };
    }

    async function commitRoleReroll(batch, captured, generatedIndex) {
        const context = getContext(),
            message = getChat()?.[captured.floor];
        const previous = captured.baseline,
            count = previous.swipes.length;
        const fail = () => {
            throw Object.assign(new Error('备选回复在生成期间发生变化，已保留原结果，请核对聊天'), { uncertain: true });
        };
        if (snapshot().identity !== captured.identity || !message || roleGeneration || snapshot().generating === true)
            fail();
        if (getChat()?.[batch.promptFloor]?.mes !== batch.template.replaceAll('[[角色名]]', () => captured.name))
            fail();
        if (
            generatedIndex !== count ||
            message.swipe_id !== count ||
            message.swipes?.length !== count + 1 ||
            previous.swipes.some((text, index) => message.swipes[index] !== text) ||
            previous.swipes.some(
                (_, index) =>
                    index !== captured.index &&
                    JSON.stringify(previous.swipe_info?.[index]) !== JSON.stringify(message.swipe_info?.[index]),
            )
        )
            fail();
        const generatedInfo = message.swipe_info?.[count],
            receipt = generatedInfo?.extra?.nag_role_batch;
        if (
            receipt?.taskId !== batch.id ||
            receipt.itemId !== captured.itemId ||
            !batch.dispatch?.attemptId ||
            receipt.attemptId !== batch.dispatch.attemptId ||
            receipt.status !== 'complete' ||
            typeof message.swipes[count] !== 'string' ||
            !message.swipes[count].trim()
        )
            fail();
        const next = structuredClone(previous);
        next.swipes[captured.index] = message.swipes[count];
        next.swipe_info ??= [];
        const oldEntry = previous.swipe_info?.[captured.index]?.extra?.[ROLE_ENTRY_KEY];
        const info = structuredClone(generatedInfo);
        if (oldEntry) {
            info.extra ??= {};
            info.extra[ROLE_ENTRY_KEY] = structuredClone(oldEntry);
        }
        next.swipe_info[captured.index] = info;
        selectPage(next, captured.index);
        return persistReplacement(context, captured.floor, captured.identity, message, next, captured.index);
    }

    // ST <= 1.16 ignores syncSwipeToMes' third argument and would rewrite the live message instead of `next`,
    // leaving next.mes/extra on the old text. Select the page on `next` directly (same fields as core).
    function selectPage(next, index) {
        const page = next.swipe_info?.[index];
        Object.assign(next, {
            swipe_id: index,
            mes: next.swipes[index],
            send_date: page?.send_date,
            gen_started: page?.gen_started,
            gen_finished: page?.gen_finished,
            extra: structuredClone(page?.extra ?? {}),
        });
    }

    /** Swap the floor to `next`, confirm it on disk (rolling back on failure), then re-render it. */
    async function persistReplacement(context, floor, identity, message, next, index) {
        const chat = getChat();
        if (snapshot().identity !== identity || !chat || chat[floor] !== message)
            throw Object.assign(new Error('聊天或回复已变化，未写入候选版本'), { uncertain: true });
        chat[floor] = next;
        try {
            // ST's saveChatConditional() silently skips the save when another save holds isChatSaving for >1s
            // (large chats, slow disks, extensions saving after MESSAGE_RECEIVED). Retry before declaring failure.
            for (let attempt = 1; ; attempt++) {
                if (snapshot().identity !== identity || chat !== getChat() || chat[floor] !== next)
                    throw Object.assign(new Error('保存期间聊天已切换，请回原聊天核对结果'), { uncertain: true });
                await context.saveChat();
                const saved = await readSavedChat(context);
                if (snapshot().identity !== identity || chat !== getChat() || chat[floor] !== next)
                    throw Object.assign(new Error('保存期间聊天已切换，请回原聊天核对结果'), { uncertain: true });
                if (
                    JSON.stringify(saved[floor]?.swipes) === JSON.stringify(next.swipes) &&
                    JSON.stringify(saved[floor]?.swipe_info) === JSON.stringify(next.swipe_info)
                )
                    break;
                if (attempt >= 4)
                    throw Object.assign(new Error('新回复的保存结果无法确认，请保留页面并检查酒馆聊天'), {
                        uncertain: true,
                    });
                await abortableDelay(500 * attempt);
            }
        } catch (error) {
            if (snapshot().identity === identity && chat === getChat() && chat[floor] === next) chat[floor] = message;
            if (error && typeof error === 'object') error.uncertain = true;
            throw error;
        }
        try {
            context.addOneMessage(next, { type: 'swipe', forceId: floor, scroll: false });
            if (context.eventTypes?.MESSAGE_SWIPED)
                await context.eventSource.emit(context.eventTypes.MESSAGE_SWIPED, floor);
            return { index, refreshFailed: false };
        } catch {
            return { index, refreshFailed: true };
        }
    }

    // ---- Preview before replace: trial candidates live at the tail with a previewId receipt. ----
    function rolePreview(batch) {
        const preview = batch?.preview;
        const message = preview ? getChat()?.[preview.floor] : null;
        const candidates =
            preview && message && Array.isArray(message.swipes)
                ? message.swipes
                      .map((_, index) => index)
                      .filter((index) => {
                          const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch;
                          return (
                              index >= preview.count && receipt?.taskId === batch.id && receipt.previewId === preview.id
                          );
                      })
                : [];
        const displayed = message?.swipe_id ?? 0;
        return { preview, message, candidates, displayed, onCandidate: candidates.includes(displayed) };
    }

    const hashPages = (swipes) => hashRoleResult(JSON.stringify(swipes));

    async function beginRolePreview(batch, captured) {
        return {
            id: newIdentity('preview'),
            itemId: captured.itemId,
            name: captured.name,
            index: captured.index,
            floor: captured.floor,
            identity: captured.identity,
            count: captured.baseline.swipes.length,
            pagesHash: await hashPages(captured.baseline.swipes),
            createdAt: Date.now(),
        };
    }

    function assertPreviewFloor(batch, preview, message) {
        if (snapshot().identity !== batch.identity || snapshot().identity !== preview.identity)
            throw new Error('请回到原聊天后再处理待确认的候选版本');
        if (roleGeneration || snapshot().generating === true) throw new Error('请先等待当前生成结束');
        const chat = getChat();
        if (!message || message.is_user || chat?.length !== preview.floor + 1)
            throw new Error('回复楼层已经变化，无法安全处理候选版本，请核对聊天');
    }

    async function assertOriginalPages(preview, message) {
        const swipes = message.swipes.slice(0, preview.count);
        if (swipes.length !== preview.count || (await hashPages(swipes)) !== preview.pagesHash)
            throw Object.assign(new Error('原有备选回复已被修改或删除，为避免替换错页已停止；请核对后选择“放弃”'), {
                code: 'PREVIEW_BASE_CHANGED',
            });
    }

    /** Checks before generating another candidate; returns the template the prompt must still hold. */
    async function prepareRolePreviewReroll(batch) {
        const { preview, message } = rolePreview(batch);
        if (!preview) throw new Error('没有待确认的候选版本');
        assertPreviewFloor(batch, preview, message);
        if (!getChat()[batch.promptFloor]?.is_user || getChat()[batch.promptFloor].mes !== batch.template)
            throw new Error('原始提示词已变化，请先核对聊天和批次模板');
        if (message.swipe_id < message.swipes.length) syncMesToSwipe(preview.floor);
        await assertOriginalPages(preview, message);
        assertPreviewFloor(batch, preview, message);
        if (getChat()?.[preview.floor] !== message) throw new Error('聊天或回复已变化，请重新确认');
        await roleIsolation?.prepare();
        assertPreviewFloor(batch, preview, message);
        if (getChat()?.[preview.floor] !== message) throw new Error('聊天或回复已变化，请重新确认');
        await getContext().saveChat();
        return preview;
    }

    async function acceptRolePreview(batch) {
        const context = getContext();
        const { preview, message, candidates, displayed, onCandidate } = rolePreview(batch);
        if (!preview) throw new Error('没有待确认的候选版本');
        assertPreviewFloor(batch, preview, message);
        if (!candidates.length) throw new Error('候选页已被删除，请选择“放弃”结束待确认状态');
        if (!onCandidate) throw new Error('请先切换到要采用的候选页，再点击“用这版替换”');
        if (message.swipe_id < message.swipes.length) syncMesToSwipe(preview.floor);
        const previousPages = JSON.stringify({ swipes: message.swipes, swipe_info: message.swipe_info });
        const assertUnchanged = () => {
            if (
                snapshot().identity !== preview.identity ||
                getChat()?.[preview.floor] !== message ||
                message.swipe_id !== displayed ||
                JSON.stringify({ swipes: message.swipes, swipe_info: message.swipe_info }) !== previousPages
            )
                throw new Error('聊天或备选回复已变化，请重新确认');
        };
        await assertOriginalPages(preview, message);
        assertPreviewFloor(batch, preview, message);
        assertUnchanged();
        const text = message.swipes[displayed];
        const generatedInfo = message.swipe_info[displayed];
        const status = generatedInfo?.extra?.nag_role_batch?.status;
        if (typeof text !== 'string' || !text.trim() || text.trim() === '...')
            throw new Error('这一版没有正文，请换一版或再生成');
        if (!['complete', 'invalid'].includes(status))
            throw new Error('这一版生成未正常结束（已停止或中断），请换一版或再生成');
        const next = structuredClone(message);
        const info = structuredClone(generatedInfo);
        info.extra ??= {};
        const receipt = { ...info.extra.nag_role_batch };
        delete receipt.previewId;
        info.extra.nag_role_batch = receipt;
        const oldEntry = message.swipe_info?.[preview.index]?.extra?.[ROLE_ENTRY_KEY];
        if (oldEntry) info.extra[ROLE_ENTRY_KEY] = structuredClone(oldEntry);
        else delete info.extra[ROLE_ENTRY_KEY];
        // The candidate may have been edited by hand; keep the isolation checksum in step with the accepted text.
        if (info.extra[RESULT_HASH_KEY] || roleIsolation?.active())
            info.extra[RESULT_HASH_KEY] = await hashRoleResult(text);
        assertUnchanged();
        next.swipes[preview.index] = text;
        next.swipe_info[preview.index] = info;
        const drop = new Set(candidates);
        next.swipes = next.swipes.filter((_, index) => !drop.has(index));
        next.swipe_info = next.swipe_info.filter((_, index) => !drop.has(index));
        selectPage(next, preview.index);
        const result = await persistReplacement(context, preview.floor, preview.identity, message, next, preview.index);
        return { ...result, status, text };
    }

    async function discardRolePreview(batch) {
        const context = getContext();
        const { preview, message, candidates } = rolePreview(batch);
        if (!preview) return { index: null, refreshFailed: false };
        if (
            snapshot().identity === preview.identity &&
            !roleGeneration &&
            snapshot().generating !== true &&
            (!message || message.is_user || getChat()?.length !== preview.floor + 1)
        )
            return { index: null, refreshFailed: false, skipped: true };
        assertPreviewFloor(batch, preview, message);
        if (message.swipe_id < message.swipes.length) syncMesToSwipe(preview.floor);
        const drop = new Set(candidates);
        const next = structuredClone(message);
        next.swipes = next.swipes.filter((_, index) => !drop.has(index));
        next.swipe_info = (next.swipe_info || []).filter((_, index) => !drop.has(index));
        const keepView = drop.has(message.swipe_id) || message.swipe_id === preview.index;
        const index = Math.min(keepView ? preview.index : message.swipe_id, next.swipes.length - 1);
        if (!drop.size && message.swipe_id === index) return { index, refreshFailed: false };
        selectPage(next, Math.max(0, index));
        return persistReplacement(context, preview.floor, preview.identity, message, next, index);
    }

    /** Show one page of the result floor (used to land on the newest candidate after a trial generation). */
    async function showRolePage(floor, index, identity) {
        if (roleGeneration || snapshot().generating === true || snapshot().identity !== identity) return false;
        const context = getContext(),
            message = getChat()?.[floor];
        if (!message || !Array.isArray(message.swipes) || index < 0 || index >= message.swipes.length) return false;
        if (message.swipe_id === index) return true;
        if (message.swipe_id < message.swipes.length) syncMesToSwipe(floor);
        if (!syncSwipeToMes(floor, index, message)) return false;
        context.addOneMessage(message, { type: 'swipe', forceId: floor, scroll: false });
        if (context.eventTypes?.MESSAGE_SWIPED)
            await context.eventSource.emit(context.eventTypes.MESSAGE_SWIPED, floor);
        await context.saveChat();
        return true;
    }

    async function restoreRoleRerollView(captured) {
        if (!captured || roleGeneration || snapshot().generating === true || snapshot().identity !== captured.identity)
            return false;
        const context = getContext(),
            message = getChat()?.[captured.floor];
        const previous = captured.baseline.swipes;
        if (
            !message ||
            !Array.isArray(message.swipes) ||
            message.swipes.length < previous.length ||
            previous.some((text, index) => message.swipes[index] !== text)
        )
            return false;
        if (message.swipe_id !== captured.index) {
            if (message.swipe_id < message.swipes.length) syncMesToSwipe(captured.floor);
            if (!syncSwipeToMes(captured.floor, captured.index, message)) return false;
            context.addOneMessage(message, { type: 'swipe', forceId: captured.floor, scroll: false });
            if (context.eventTypes?.MESSAGE_SWIPED)
                await context.eventSource.emit(context.eventTypes.MESSAGE_SWIPED, captured.floor);
            await context.saveChat();
        }
        return true;
    }

    async function generateRoleReply(
        batch,
        text,
        { signal, assertCurrent, timeoutMs = 600000, validationOptions = {}, expectedPrompt },
    ) {
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
        if (expectedPrompt !== undefined && prompt.mes !== expectedPrompt)
            throw Object.assign(new Error('原始提示词已变化，未发送重生成请求'), { uncertain: true });
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
        const existingErrorNotices = new Set(getDocument()?.querySelectorAll?.('#toast-container .toast-error') || []);
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
            // Native overswipe may inherit extra from the selected imported page.
            // A fresh generation must never reuse that page's worldbook entry identity.
            delete message.extra[ROLE_ENTRY_KEY];
            delete message.swipe_info[expectedSwipe].extra[ROLE_ENTRY_KEY];
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
                markReceipt(
                    isRoleCardTruncated(text, validationOptions) ? 'invalid' : 'complete',
                    roleIsolation?.active() ? await hashRoleResult(text) : undefined,
                );
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
            if (messages.length !== batch.resultFloor + 1 || reply.swipe_id !== expectedSwipe) {
                // The host reverted the overswipe: drop the pending receipt markReceipt() left past the last swipe.
                if (
                    Array.isArray(reply.swipe_info) &&
                    Array.isArray(reply.swipes) &&
                    reply.swipe_info.length > reply.swipes.length
                ) {
                    reply.swipe_info.length = reply.swipes.length;
                    await context.saveChat();
                }
                const notices = getDocument()?.querySelectorAll?.('#toast-container .toast-error') || [];
                const hostErrorNotice = [...notices].some((notice) => !existingErrorNotices.has(notice));
                throw Object.assign(
                    new Error(
                        hostErrorNotice
                            ? '酒馆生成后退回旧候选页，检测到酒馆错误提示；请查看酒馆的 API 错误信息，原结果已保留'
                            : '酒馆生成后退回旧候选页，原因尚未确认；请查看酒馆错误提示并保留原结果',
                    ),
                    {
                        uncertain: true,
                        phase: 'select-swipe',
                        hostErrorNotice,
                        expectedSwipe,
                        actualSwipe: reply.swipe_id,
                    },
                );
            }
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
                isStreamInterrupted ? 'partial' : isRoleCardTruncated(text, validationOptions) ? 'invalid' : 'complete',
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
        getContext,
        getChat,
        captureRoleReroll,
        readRoleTemplate,
        restoreRoleTemplateIfEquals,
        commitRoleReroll,
        restoreRoleRerollView,
        rolePreview,
        beginRolePreview,
        prepareRolePreviewReroll,
        acceptRolePreview,
        discardRolePreview,
        showRolePage,
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
        async confirmUnidentifiedRolePages(batch) {
            if (snapshot().identity !== batch.identity) throw new Error('请返回原聊天后核对角色');
            const message = getChat()?.[batch.resultFloor];
            const count = countUnidentifiedRolePages(batch, message);
            if (!count) return true;
            if (typeof getContext()?.Popup?.show?.confirm !== 'function')
                throw new Error(`有 ${count} 条备选回复无法识别角色名称，请先核对后再继续`);
            return !!(await getContext().Popup.show.confirm(
                '存在无法识别的已有角色',
                `有 ${count} 条已有备选回复缺少当前批次的角色记录，无法判断是否与名单同名。请先核对，确认仍要继续生成吗？`,
            ));
        },
        generateRoleReply,
        restoreRoleTemplate,
        reconcileRoleBatch,
        importRoleResults,
        exportRoleWorldbook,
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
