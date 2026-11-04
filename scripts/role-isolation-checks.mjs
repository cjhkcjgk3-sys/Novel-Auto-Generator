import assert from 'node:assert/strict';

/** Run against the actual helper extension in the same isolated host as the batch smoke test. */
export async function runRoleIsolationChecks({ page, requests, reopenChat, connect, restartBatch, setFrontendReply }) {
    await page.waitForFunction(() => typeof window.TavernHelper?.getTavernHelperVersion === 'function');
    const helper = await page.evaluate(() => window.TavernHelper.getTavernHelperVersion());
    await page.waitForFunction(() => document.getElementById('TH-render-allow-streaming'));
    if (await page.locator('#TH-render-allow-streaming').isChecked()) {
        await page.locator('#TH-render-allow-streaming').dispatchEvent('click');
        await page.waitForFunction(() => !document.getElementById('TH-render-allow-streaming').checked);
    }
    const toggle = (enabled) =>
        page.evaluate(async (enabled) => {
            const input = window.jQuery('#nag-set-isolate-result');
            input.prop('checked', enabled);
            await input.triggerHandler('change');
            if (input.prop('checked') !== enabled) throw new Error('Isolation toggle failed');
        }, enabled);
    const snapshots = [];
    await toggle(false);
    await restartBatch();
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.chat.splice(2);
        await c.saveChat();
        await (await import('/script.js')).printMessages();
        window.__nagResultRuns = 0;
    });
    const generate = (names) =>
        page.evaluate(async (names) => {
            for (const [id, value] of Object.entries({
                'nag-set-total': String(names.length),
                'nag-set-prompt': names.join('\n'),
            })) {
                const element = document.getElementById(id);
                element.value = value;
                element.dispatchEvent(new Event('change'));
            }
            await window.jQuery('#nag-btn-start').triggerHandler('click');
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            if (settings.roleBatch.items.some((item) => item.failed))
                throw new Error('Protected frontend generation failed');
        }, names);
    setFrontendReply(true);
    await toggle(true);
    await generate(['隔离生成甲', '隔离生成乙']);
    assert.equal(
        await page.evaluate(() => window.__nagResultRuns),
        0,
        'Streaming generated code stays inert from the first result',
    );
    await page.evaluate(() => {
        const input = document.getElementById('stream_toggle');
        if (input.checked) input.click();
    });
    await generate(['隔离生成丙']);
    setFrontendReply(false);
    await page.evaluate(() => {
        const input = document.getElementById('stream_toggle');
        if (!input.checked) input.click();
    });
    assert.equal(await page.evaluate(() => window.__nagResultRuns), 0, 'Non-streamed generated code also stays inert');
    assert.equal(await page.locator('#chat .mes[mesid="2"] iframe').count(), 0);
    await toggle(false);
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const core = await import('/script.js');
        window.__nagUpperRuns = 0;
        window.__nagResultRuns = 0;
        c.chat[0].mes =
            '```html\n<html><body>UPPER_WORKBENCH<script>window.parent.__nagUpperRuns++;</script></body></html>\n```';
        c.updateMessageBlock(0, c.chat[0]);
        await c.eventSource.emit(c.eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'extension');
        await core.saveChatConditional();
    });
    await page.waitForFunction(() => window.__nagUpperRuns > 0);
    const upperRuns = await page.evaluate(() => window.__nagUpperRuns);
    const setSwipes = (count) =>
        page.evaluate(async (count) => {
            const c = window.SillyTavern.getContext();
            const reply = c.chat[2];
            reply.swipes = Array.from(
                { length: count },
                (_, index) =>
                    '```html\n<html><body>PROTECTED_RESULT_' +
                    index +
                    '<script>window.parent.__nagResultRuns++;</script>' +
                    '角色原文'.repeat(3000) +
                    '</body></html>\n```',
            );
            reply.swipe_info = reply.swipes.map(() => ({ extra: {} }));
            reply.swipe_id = count - 1;
            reply.mes = reply.swipes[count - 1];
            reply.extra = {};
            window.__nagExpectedBodies = [...reply.swipes];
            c.updateMessageBlock(2, reply);
            await c.saveChat();
        }, count);
    const sample = () =>
        page.evaluate(() => {
            const c = window.SillyTavern.getContext();
            const body = document.querySelector('#chat .mes[mesid="2"] .mes_text');
            return {
                swipes: c.chat[2].swipes.length,
                floors: document.querySelectorAll('#chat > .mes').length,
                previewCount: document.querySelectorAll('.nag-result-plain').length,
                blockers: document.querySelectorAll('.nag-result-render-blocker').length,
                targetFrames: document.querySelectorAll('#chat .mes[mesid="2"] iframe').length,
                targetCodeBlocks: body.querySelectorAll('pre,code').length,
                currentTextMatches: body.textContent === c.chat[2].mes,
                allBodiesMatch: JSON.stringify(c.chat[2].swipes) === JSON.stringify(window.__nagExpectedBodies),
                listeners: Object.values(c.eventSource.events).reduce((sum, list) => sum + list.length, 0),
            };
        });
    for (const count of [50, 100]) {
        // Set raw fixture data without dispatching a render event; enabling takes ownership first.
        await toggle(false);
        await setSwipes(count);
        await toggle(true);
        const runs = await page.evaluate(() => window.__nagResultRuns);
        for (const swipe of [0, Math.floor(count / 2), count - 1, 1, count - 1]) {
            await page.evaluate(async (swipe) => {
                const core = await import('/script.js');
                await core.swipe(null, 'right', { forceMesId: 2, forceSwipeId: swipe, forceDuration: 0 });
            }, swipe);
        }
        const result = await sample();
        assert.equal(result.swipes, count);
        assert.equal(result.floors, 3);
        assert.equal(result.previewCount, 1);
        assert.equal(result.blockers, 1);
        assert.equal(result.targetFrames, 0);
        assert.equal(result.targetCodeBlocks, 0);
        assert.equal(result.currentTextMatches, true);
        assert.equal(result.allBodiesMatch, true);
        assert.equal(await page.evaluate(() => window.__nagResultRuns), runs, 'Protected result scripts never execute');
        snapshots.push(result);
    }
    assert.equal(snapshots[0].listeners, snapshots[1].listeners, 'More swipes do not add event subscriptions');
    assert.equal(
        await page.evaluate(() => window.__nagUpperRuns),
        upperRuns,
        'The upper workbench is preserved without unnecessary remounts',
    );

    // Enable the real helper's experimental streaming renderer and exercise its native event path.
    await page.locator('#TH-render-allow-streaming').dispatchEvent('click');
    await page.locator('.TH-popup [role="dialog"] .popup-button-ok').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#TH-render-allow-streaming')?.checked);
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        await c.eventSource.emit(c.eventTypes.STREAM_TOKEN_RECEIVED, 'synthetic token');
        await c.eventSource.emit(c.eventTypes.CHARACTER_MESSAGE_RENDERED, 2, 'extension');
    });
    const streamed = await sample();
    assert.equal(streamed.targetFrames, 0);
    assert.equal(streamed.currentTextMatches, true);

    // Turning protection off must really restore helper rendering, not just change a checkbox.
    await toggle(false);
    await page.waitForFunction(() => window.__nagResultRuns > 0);
    await toggle(true);
    await page.waitForFunction(() => !document.querySelector('#chat .mes[mesid="2"] iframe'));
    const beforeReload = await page.evaluate(async () => {
        const core = await import('/script.js');
        await core.saveChatConditional();
        await core.saveSettings();
        return [...window.SillyTavern.getContext().chat[2].swipes];
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
        () => document.getElementById('nag-btn-isolate-result') || document.getElementById('nag-set-isolate-result'),
    );
    await reopenChat();
    await connect();
    assert.deepEqual(await page.evaluate(() => window.SillyTavern.getContext().chat[2].swipes), beforeReload);
    await page.waitForFunction(() => document.querySelector('#chat .mes[mesid="2"] .nag-result-plain'));
    assert.equal(await page.locator('#chat .mes[mesid="2"] iframe').count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    const fits = await page
        .locator('#chat .mes[mesid="2"] .mes_text')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(fits, true, 'Long raw CJK text fits a phone-width preview');

    // A normal native generation also excludes just this result floor, preserving earlier rules and command.
    const requestCount = requests.length;
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const command = { name: c.name1, is_user: true, mes: 'NEW_COMMAND_SENTINEL', extra: {} };
        c.chat.push(command);
        c.addOneMessage(command);
        await c.generate('normal');
    });
    assert.equal(requests.length, requestCount + 1);
    const prompt = JSON.stringify(requests.at(-1).messages);
    assert.ok(prompt.includes('NEW_COMMAND_SENTINEL'));
    assert.ok(prompt.includes('UPPER_WORKBENCH'));
    assert.ok(prompt.includes('CARD_FORMAT_SENTINEL'));
    assert.ok(prompt.includes('WORLD_FORMAT_SENTINEL'));
    assert.ok(!prompt.includes('PROTECTED_RESULT_'));
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.chat.splice(3);
        await c.saveChat();
        const core = await import('/script.js');
        await core.printMessages();
        await c.eventSource.emit(c.eventTypes.CHAT_CHANGED, c.chatId);
        c.chat[2].swipes[5] += ' unexpected edit';
        await window.jQuery('#nag-btn-start').triggerHandler('click');
    });
    assert.equal(requests.length, requestCount + 1, 'An altered protected result stops before another model call');
    const error = await page.evaluate(() =>
        window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].errorLog.at(-1),
    );
    assert.equal(error.code, 'RESULT_CHANGED');
    assert.ok(!JSON.stringify(error).includes('PROTECTED_RESULT_'));
    const cleanup = await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const entry = await import('/scripts/extensions/third-party/Novel-Auto-Generator/index.js');
        const count = () => c.eventSource.events.TH_REQUEST_RENDER_MESSAGE.length;
        const before = count();
        entry.disposeNovelExtension();
        const after = count();
        const cleared =
            !document.querySelector('.nag-result-plain, .nag-result-render-blocker') &&
            typeof window.NovelGen_isolateRoleResult === 'undefined';
        entry.enableNovelExtension();
        return { before, after, cleared, enabledAgain: count() };
    });
    assert.equal(cleanup.after, cleanup.before - 1);
    assert.equal(cleanup.enabledAgain, cleanup.before);
    assert.equal(cleanup.cleared, true);
    return {
        helper,
        streamedRoleGeneration: true,
        jsonRoleGeneration: true,
        snapshots,
        helperStreamingBlocked: true,
        toggleRestoresRendering: true,
        reloadPreserves100Swipes: true,
        phoneWidth: true,
        promptIsolation: true,
        tamperStopsDispatch: true,
        cleanupAndReenable: true,
    };
}
