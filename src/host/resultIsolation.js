import { clearRoleResultHashes, verifyRoleResults } from './roleResultIntegrity.js';

export const ROLE_RESULT_INTERCEPTOR = 'NovelGen_isolateRoleResult';

/** One owned message body, one observer and a fixed set of native event subscriptions. */
export function createRoleResultIsolation({
    getContext,
    getChat,
    snapshot,
    getDocument,
    getBatch,
    onError = () => {},
    restoreLegacyVisibility = async () => {},
}) {
    let guarded = null;
    let observer = null;
    let observedRoot = null;
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

    function release(render = false) {
        if (!guarded) return;
        const old = guarded;
        guarded = null;
        if (old.descriptor) Object.defineProperty(old.element, 'innerHTML', old.descriptor);
        else delete old.element.innerHTML;
        old.element.classList.remove('nag-result-plain');
        old.marker.remove();
        if (render && old.element.isConnected && snapshot().identity === old.identity) {
            const message = getChat()?.[old.floor];
            if (message) {
                getContext().updateMessageBlock(old.floor, message);
                void source?.emit(context.eventTypes?.CHARACTER_MESSAGE_RENDERED, old.floor, 'extension');
            }
        }
    }

    function paint() {
        const current = target();
        if (!guarded || !current || current.floor !== guarded.floor) return;
        if (guarded.element.querySelector('#curEditTextarea')) return;
        const text = String(current.message.mes || '');
        if (guarded.element.childElementCount || guarded.element.textContent !== text)
            guarded.element.textContent = text;
        guarded.element.classList.remove('hidden!');
        guarded.element.classList.add('nag-result-plain');
        if (!guarded.marker.isConnected) guarded.element.after(guarded.marker);
    }

    function refresh() {
        if (disposed) return;
        const current = target();
        const document = getDocument();
        const root = document?.querySelector('#chat');
        if (!getBatch() || snapshot().identity !== getBatch().identity) {
            observer?.disconnect();
            observedRoot = null;
            release(true);
            return;
        }
        if (root && root !== observedRoot && document.defaultView?.MutationObserver) {
            observer?.disconnect();
            observer = new document.defaultView.MutationObserver(refresh);
            observer.observe(root, { childList: true, subtree: true, characterData: true });
            observedRoot = root;
        }
        const element = current && root?.querySelector(`.mes[mesid="${current.floor}"] .mes_text`);
        if (!element) {
            release();
            return;
        }
        if (guarded?.element !== element) {
            release();
            const native = Object.getOwnPropertyDescriptor(document.defaultView.Element.prototype, 'innerHTML');
            const descriptor = Object.getOwnPropertyDescriptor(element, 'innerHTML');
            if (!native?.get || descriptor?.configurable === false)
                throw Object.assign(new Error('结果正文已被其他插件独占，无法启用纯文本隔离'), {
                    code: 'ISOLATION_CONFLICT',
                    uncertain: true,
                });
            const marker = document.createElement('div');
            // Tavern Helper's streaming renderer yields to message-owned streaming displays.
            marker.className = 'mes_streaming nag-result-render-blocker';
            marker.hidden = true;
            marker.setAttribute('aria-hidden', 'true');
            guarded = {
                ...current,
                element,
                marker,
                descriptor,
            };
            Object.defineProperty(element, 'innerHTML', {
                configurable: true,
                get() {
                    return native.get.call(this);
                },
                set() {
                    paint();
                },
            });
        }
        paint();
    }

    async function prepare() {
        const current = target();
        if (!current) return;
        if (typeof source?.makeFirst !== 'function')
            throw Object.assign(new Error('当前酒馆缺少优先渲染事件接口，请关闭结果隔离或升级酒馆'), {
                code: 'ISOLATION_UNSUPPORTED',
                uncertain: true,
            });
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
        if (context.eventTypes?.CHARACTER_MESSAGE_RENDERED)
            await source.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, current.floor, 'extension');
    }

    async function verify() {
        const current = target();
        if (current) await verifyRoleResults(current.message, { assertCurrent: () => assertTarget(current) });
    }

    async function intercept(messages, _size, abort) {
        const current = target();
        if (!current) return;
        try {
            await verify();
            const receipt = current.message.extra?.nag_role_batch;
            for (let index = messages.length - 1; index >= 0; index--) {
                const message = messages[index];
                const other = message.extra?.nag_role_batch;
                if (
                    !message.is_user &&
                    ((current.message.extra && message.extra === current.message.extra) ||
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
        ...[
            'CHARACTER_MESSAGE_RENDERED',
            'MESSAGE_SWIPED',
            'MESSAGE_UPDATED',
            'MESSAGE_RECEIVED',
            'STREAM_TOKEN_RECEIVED',
            'CHAT_CHANGED',
            'MORE_MESSAGES_LOADED',
            'MESSAGE_DELETED',
        ]
            .map((key) => context?.eventTypes?.[key])
            .filter(Boolean),
        'chatLoaded',
        'TH_REQUEST_RENDER_MESSAGE',
    ]);
    const reload = () => {
        void restoreLegacyVisibility().catch((error) => onError(error, { phase: 'restore-legacy-visibility' }));
        refresh();
    };
    for (const event of events) {
        if (typeof source?.makeFirst === 'function') {
            const listener = event === 'chatLoaded' || event === context.eventTypes?.CHAT_CHANGED ? reload : refresh;
            source.makeFirst(event, listener);
            subscriptions.push([event, listener]);
        }
    }
    globalThis[ROLE_RESULT_INTERCEPTOR] = intercept;
    return {
        refresh,
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
            observer?.disconnect();
            observer = null;
            for (const [event, listener] of subscriptions) source.removeListener(event, listener);
            if (globalThis[ROLE_RESULT_INTERCEPTOR] === intercept) delete globalThis[ROLE_RESULT_INTERCEPTOR];
            release(true);
        },
    };
}
