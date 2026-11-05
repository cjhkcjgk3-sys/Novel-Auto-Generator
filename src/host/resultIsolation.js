import { clearRoleResultHashes, verifyRoleResults } from './roleResultIntegrity.js';

export const ROLE_RESULT_INTERCEPTOR = 'NovelGen_isolateRoleResult';

/** Keep native swipe rendering; isolate only request copies and verify stored result bodies. */
export function createRoleResultIsolation({
    getContext,
    getChat,
    snapshot,
    getDocument,
    getBatch,
    onError = () => {},
    restoreLegacyVisibility = async () => {},
}) {
    let preparing = null;
    let disposed = false;
    const context = getContext();
    const source = context?.eventSource;
    const subscriptions = [];

    function target() {
        const batch = getBatch();
        if (!batch || snapshot().identity !== batch.identity) return null;
        const floor = batch.resultFloor ?? batch.promptFloor + 1;
        const message = getChat()?.[floor];
        if (!message || message.is_user || message.is_system) return null;
        return { batch, floor, message, identity: batch.identity };
    }

    function assertTarget(current) {
        if (disposed || target()?.message !== current.message || snapshot().identity !== current.identity)
            throw Object.assign(new Error('聊天或隔离目标已切换，已停止本次操作'), {
                code: 'ABORTED',
                uncertain: true,
            });
    }

    function previewWindow() {
        const current = target();
        if (!current) return [];
        const selected = current.message.swipe_id ?? 0;
        // Native overswipe selects the new page before its first token is stored.
        const last = Math.max(selected, (current.message.swipes?.length || 1) - 1);
        return [selected - 1, selected, selected + 1].filter((index) => index >= 0 && index <= last);
    }

    function refresh() {
        if (disposed) return;
        const hint = getDocument()?.querySelector('#nag-result-preview-window');
        if (!hint) return;
        const pages = previewWindow();
        hint.hidden = !pages.length;
        hint.textContent = pages.length
            ? `正常预览：第 ${pages.map((index) => index + 1).join('、')} 页`
            : '当前页及前后各一页正常预览';
        // Core mounts only the selected swipe; inactive bodies remain native data.
        // Do not rewrite .mes_text, intercept innerHTML, or remount helper frontends.
    }

    async function prepare() {
        const current = target();
        if (!current) return;
        if (!preparing) {
            preparing = (async () => {
                if (
                    await verifyRoleResults(current.message, { seal: true, assertCurrent: () => assertTarget(current) })
                ) {
                    assertTarget(current);
                    await getContext().saveChat();
                }
            })().finally(() => {
                preparing = null;
            });
        }
        await preparing;
        assertTarget(current);
        refresh();
    }

    async function verify() {
        const current = target();
        if (current) await verifyRoleResults(current.message, { assertCurrent: () => assertTarget(current) });
    }

    async function intercept(messages, _size, abort) {
        const current = target();
        if (!current) return;
        try {
            // Native swipe replaces message.extra; bind the request copy before awaiting verification.
            const extra = current.message.extra;
            const receipt = extra?.nag_role_batch;
            await verify();
            for (let index = messages.length - 1; index >= 0; index--) {
                const message = messages[index];
                const other = message.extra?.nag_role_batch;
                if (
                    !message.is_user &&
                    ((extra && message.extra === extra) ||
                        (receipt?.attemptId &&
                            other?.taskId === receipt.taskId &&
                            other?.itemId === receipt.itemId &&
                            other?.attemptId === receipt.attemptId))
                )
                    messages.splice(index, 1);
            }
        } catch (error) {
            abort(true);
            onError(error, { phase: 'result-integrity' });
        }
    }

    const events = new Set([
        ...['MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_DELETED']
            .map((key) => context?.eventTypes?.[key])
            .filter(Boolean),
        'chatLoaded',
    ]);
    const reload = () => {
        void restoreLegacyVisibility().catch((error) => onError(error, { phase: 'restore-legacy-visibility' }));
        refresh();
    };
    for (const event of events) {
        if (typeof source?.on === 'function') {
            const listener = event === 'chatLoaded' || event === context.eventTypes?.CHAT_CHANGED ? reload : refresh;
            source.on(event, listener);
            subscriptions.push([event, listener]);
        }
    }
    globalThis[ROLE_RESULT_INTERCEPTOR] = intercept;
    return {
        refresh,
        previewWindow,
        prepare,
        verify,
        active: () => !!target(),
        async resetProtection() {
            const current = target();
            if (current) {
                clearRoleResultHashes(current.message);
                await getContext().saveChat();
            }
        },
        dispose() {
            disposed = true;
            for (const [event, listener] of subscriptions) source.removeListener(event, listener);
            if (globalThis[ROLE_RESULT_INTERCEPTOR] === intercept) delete globalThis[ROLE_RESULT_INTERCEPTOR];
            const hint = getDocument()?.querySelector('#nag-result-preview-window');
            if (hint) {
                hint.hidden = true;
                hint.textContent = '';
            }
        },
    };
}
