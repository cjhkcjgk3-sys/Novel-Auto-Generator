/** Resolve the selected native swipe through the batch receipt, never by parsing character text. */
export function selectedRole(batch, message) {
    if (!batch || !message || message.is_user || message.is_system) return null;
    const index = message.swipe_id ?? 0;
    if (!Number.isInteger(index) || typeof message.swipes?.[index] !== 'string') return null;
    const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch ?? message.extra?.nag_role_batch;
    const candidates = [...(batch.items || []), ...(batch.history || [])];
    let matches = [];
    if (receipt?.taskId === batch.id && receipt.itemId)
        matches = candidates.filter((item) => item.id === receipt.itemId);
    else if (!receipt) matches = candidates.filter((item) => item.legacy && item.swipe === index);
    if (matches.length !== 1 || !matches[0].name || matches[0].swipe !== index) return null;
    return { item: matches[0], index };
}

/** Add one control to the native message and render the prompt as a view-only substitution. */
export function createRoleSelectionUI({ host, getBatch, isBusy, onReroll }) {
    const context = host.getContext();
    const source = context?.eventSource;
    const subscriptions = [];
    let disposed = false;
    let lastPrompt = null;
    function clearPrompt() {
        if (!lastPrompt) return;
        const { identity, floor, original } = lastPrompt;
        lastPrompt = null;
        if (host.snapshot().identity === identity && host.getChat()?.[floor] === original)
            context.updateMessageBlock(floor, original);
    }
    function refresh() {
        if (disposed) return;
        const batch = getBatch(),
            chat = host.getChat(),
            identity = host.snapshot().identity;
        const floor = batch?.resultFloor;
        const message = Number.isInteger(floor) ? chat?.[floor] : null;
        const selected = batch?.identity === identity ? selectedRole(batch, message) : null;
        const canReroll = !!selected && chat?.length === floor + 1;
        const document = globalThis.document;
        for (const button of document.querySelectorAll('.nag-reroll-role')) {
            if (!canReroll || button.closest('.mes')?.getAttribute('mesid') !== String(floor)) button.remove();
        }
        if (!selected) {
            clearPrompt();
            return;
        }
        const prompt = chat[batch.promptFloor];
        const promptNode = document.querySelector(`#chat .mes[mesid="${batch.promptFloor}"]`);
        if (!isBusy() && prompt?.is_user && prompt.mes === batch.template && !promptNode?.querySelector('textarea')) {
            const sourceText =
                typeof prompt.extra?.display_text === 'string' ? prompt.extra.display_text : batch.template;
            if (!sourceText.includes('[[角色名]]')) clearPrompt();
            else {
                const display = sourceText.replaceAll('[[角色名]]', () => selected.item.name);
                if (
                    lastPrompt?.floor !== batch.promptFloor ||
                    lastPrompt?.name !== selected.item.name ||
                    lastPrompt?.original !== prompt ||
                    lastPrompt?.node !== promptNode ||
                    lastPrompt?.sourceText !== sourceText
                ) {
                    context.updateMessageBlock(batch.promptFloor, {
                        ...prompt,
                        extra: { ...prompt.extra, display_text: display },
                    });
                    lastPrompt = {
                        identity,
                        floor: batch.promptFloor,
                        original: prompt,
                        name: selected.item.name,
                        node: promptNode,
                        sourceText,
                    };
                }
            }
        } else if (!isBusy()) clearPrompt();
        if (!canReroll) return;
        const container = document.querySelector(`#chat .mes[mesid="${floor}"] .mes_buttons`);
        if (!container) return;
        let button = container.querySelector('.nag-reroll-role');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'nag-reroll-role menu_button';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void onReroll();
            });
            container.appendChild(button);
        }
        button.textContent = '↻ 重生成此角色';
        button.title = `重新生成 ${selected.item.name}`;
        button.disabled = isBusy();
    }
    for (const name of [
        'MESSAGE_SWIPED',
        'MESSAGE_RECEIVED',
        'CHAT_CHANGED',
        'CHAT_LOADED',
        'MESSAGE_DELETED',
        'MESSAGE_UPDATED',
        'MESSAGE_EDITED',
        'MESSAGE_SWIPE_DELETED',
        'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED',
    ]) {
        const event = context?.eventTypes?.[name];
        if (!event || subscriptions.some(([name]) => name === event)) continue;
        const listener =
            name === 'USER_MESSAGE_RENDERED'
                ? (id) => {
                      if (id === lastPrompt?.floor) lastPrompt = null;
                      refresh();
                  }
                : refresh;
        source?.on(event, listener);
        subscriptions.push([event, listener]);
    }
    return {
        refresh,
        dispose() {
            disposed = true;
            clearPrompt();
            for (const [event, listener] of subscriptions) source?.removeListener(event, listener);
            for (const button of globalThis.document.querySelectorAll('.nag-reroll-role')) button.remove();
        },
    };
}
