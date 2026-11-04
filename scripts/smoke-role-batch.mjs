import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.ST_TEST_URL || 'http://127.0.0.1:18019';
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
let launch = { headless: true };
if (process.env.ST_CHROMIUM_MODULE) {
    const { default: binary } = await import(process.env.ST_CHROMIUM_MODULE);
    launch = { ...launch, executablePath: await binary.executablePath(), args: binary.args };
}
const browser = await chromium.launch(launch);
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const requests = [];
    const requestPages = [];
    let emptyReplies = false;
    let streamError = false;
    let holdResponse = false;
    let releaseResponse;
    let onHeld;
    const errors = [];
    let initializing = true;
    page.on('console', async (message) => {
        if (initializing && message.type() === 'error') {
            const values = await Promise.all(
                message
                    .args()
                    .map((arg) =>
                        arg.evaluate((value) => (value instanceof Error ? value.stack : String(value))).catch(() => ''),
                    ),
            );
            console.error('Host initialization:', values.join(' '));
        }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    for (const endpoint of ['text-models', 'text-workers'])
        await page.route(`**/api/horde/${endpoint}`, (route) => route.fulfill({ json: [] }));
    await page.route('**/api/horde/status', (route) => route.fulfill({ json: { ok: false } }));
    await page.route('**/api/backends/chat-completions/status', (route) =>
        route.fulfill({ json: { data: [{ id: 'fixture-model' }] } }),
    );
    await page.route('**/api/backends/chat-completions/generate', async (route) => {
        const body = route.request().postDataJSON();
        requests.push(body);
        requestPages.push(
            await page.evaluate(() => ({
                swipe: window.SillyTavern.getContext().chat.at(-1)?.swipe_id,
                counter: document
                    .querySelector('#chat .last_mes .swipes-counter')
                    ?.textContent?.replace(/[\s\u200B-\u200D\uFEFF]/g, ''),
            })),
        );
        if (holdResponse) {
            await new Promise((resolve) => {
                releaseResponse = resolve;
                onHeld?.();
            });
        }
        if (streamError) {
            assert.equal(body.stream, true);
            return route.fulfill({
                contentType: 'text/event-stream',
                body: `data: ${JSON.stringify({ error: { message: 'Synthetic stream failure before first token' } })}\n\n`,
            });
        }
        const text = emptyReplies
            ? ''
            : `[start]\n<character_design_complex>\nname: 测试角色${requests.length}\nversion: 1\nnotes: ROLE_RESULT_${requests.length}\n</character_design_complex>\n[end]`;
        if (!body.stream)
            return route.fulfill({ json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
        return route.fulfill({
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    const welcomeInput = page.locator('.popup-input:visible');
    if (await welcomeInput.count()) {
        await welcomeInput.last().fill('RoleBatchQA');
        await page.locator('.popup-button-ok:visible').last().click();
        await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length > 0);
    }
    const name = `RoleBatchQA-${Date.now()}`;
    const card = process.env.SMOKE_CARD
        ? JSON.parse(fs.readFileSync(process.env.SMOKE_CARD, 'utf8'))
        : {
              spec: 'chara_card_v2',
              spec_version: '2.0',
              data: { name, description: '', first_mes: '', character_book: { entries: [] } },
          };
    card.name = card.data.name = name;
    card.first_mes = card.data.first_mes = '写卡助手验收';
    card.data.description += '\nCARD_FORMAT_SENTINEL：严格遵守角色卡输出格式。';
    card.data.character_book.entries.push({
        id: 99991,
        keys: [],
        content: 'WORLD_FORMAT_SENTINEL：角色资料必须使用规定的格式。',
        constant: true,
        enabled: true,
        insertion_order: 1000000,
        position: 'before_char',
        extensions: {},
    });
    const token = (await (await page.request.get(url + '/csrf-token')).json()).token;
    const worldName = name + '-Worldbook';
    card.data.extensions ??= {};
    card.data.extensions.world = worldName;
    const entries = Object.fromEntries(
        card.data.character_book.entries.map((entry, uid) => [
            uid,
            {
                uid,
                key: entry.keys || [],
                keysecondary: entry.secondary_keys || [],
                content: entry.content,
                comment: entry.comment || '',
                constant: !!entry.constant,
                disable: entry.enabled === false,
                order: entry.insertion_order || 0,
                position: entry.extensions?.position ?? 0,
            },
        ]),
    );
    const world = await page.request.post(url + '/api/worldinfo/edit', {
        headers: { 'X-CSRF-Token': token },
        data: { name: worldName, data: { entries } },
    });
    assert.ok(world.ok(), await world.text());
    const imported = await page.request.post(url + '/api/characters/import', {
        headers: { 'X-CSRF-Token': token },
        multipart: {
            file_type: 'json',
            avatar: { name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) },
        },
    });
    assert.ok(imported.ok(), await imported.text());
    const importedName = (await imported.json()).file_name;
    const avatar = importedName.endsWith('.png') ? importedName : importedName + '.png';
    await page.reload({ waitUntil: 'networkidle' });
    await page
        .waitForFunction(
            (avatar) => window.SillyTavern?.getContext().characters.some((c) => c.avatar === avatar),
            avatar,
        )
        .catch(async (error) => {
            console.error({
                avatar,
                errors,
                state: await page.evaluate(() => ({
                    characters: window.SillyTavern?.getContext().characters.map((c) => c.avatar),
                    body: document.body.innerText.slice(-1400),
                })),
            });
            throw error;
        });
    const index = await page.evaluate(
        (avatar) => SillyTavern.getContext().characters.findIndex((c) => c.avatar === avatar),
        avatar,
    );
    assert.ok(index >= 0, 'Imported writing assistant is available');
    await page.locator('#CharID' + index).dispatchEvent('click');
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page
        .waitForFunction(() => document.getElementById('nag-set-mode'))
        .catch((error) => {
            console.error(JSON.stringify({ initializationErrors: errors }));
            throw error;
        });
    initializing = false;
    await page.locator('#main_api').selectOption('openai', { force: true });
    await page.locator('#chat_completion_source').selectOption('custom', { force: true });
    await page.locator('#custom_api_url_text').fill('http://127.0.0.1:18080/v1', { force: true });
    await page.locator('#custom_api_url_text').dispatchEvent('input');
    await page.locator('#custom_model_id').fill('fixture-model', { force: true });
    await page.locator('#custom_model_id').dispatchEvent('input');
    await page.locator('#api_button_openai').dispatchEvent('click');
    await page.locator('#stream_toggle').check({ force: true });
    await page.evaluate(async () => {
        const c = SillyTavern.getContext();
        const message = {
            is_user: true,
            name: c.name1,
            mes: '小助手生成角色：[[角色名]]。名字为[[角色名]]。',
            extra: {},
        };
        c.chat.push(message);
        c.addOneMessage(message);
        await c.saveChat();
        const mode = document.getElementById('nag-set-mode');
        mode.value = 'role-batch';
        mode.dispatchEvent(new Event('change'));
        for (const [id, value] of Object.entries({
            'nag-set-total': '3',
            'nag-set-prompt': '角色甲\n角色乙\n角色丙',
            'nag-set-reply-wait': '1',
        })) {
            const node = document.getElementById(id);
            node.value = value;
            node.dispatchEvent(new Event('change'));
        }
        document.getElementById('nag-btn-reset').click();
    });
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    // A previous manual stop must not leave the next generation using an aborted core controller.
    await page.locator('#nag-btn-clear-errors').dispatchEvent('click');
    await page.evaluate(() => window.SillyTavern.getContext().stopGeneration());
    await page.evaluate(() => document.getElementById('nag-btn-start').click());
    await page
        .waitForFunction(
            () => {
                const settings = SillyTavern.getContext().extensionSettings['novel-auto-generator'];
                return !settings.isRunning;
            },
            null,
            { timeout: 60000 },
        )
        .catch(async (error) => {
            console.error(
                await page.evaluate(() => ({
                    progress: document.getElementById('nag-progress-text').textContent,
                    statuses: document.getElementById('nag-role-results').textContent,
                    notices: document.querySelector('#toast-container')?.textContent,
                })),
            );
            throw error;
        });
    const result = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        return {
            floors: c.chat.length,
            prompt: c.chat[1].mes,
            replies: c.chat[2].swipes,
            ui: document.getElementById('nag-role-results').textContent,
        };
    });
    assert.equal(requests.length, 3);
    assert.equal(requestPages[1].swipe, 1);
    assert.ok(requestPages[1].counter?.startsWith('2/'), JSON.stringify(requestPages));
    assert.equal(result.floors, 3);
    assert.equal(result.replies.length, 3);
    assert.equal(result.prompt, '小助手生成角色：[[角色名]]。名字为[[角色名]]。');
    assert.ok(result.ui.includes('✅'));
    ['角色甲', '角色乙', '角色丙'].forEach((name, i) => {
        const prompt = JSON.stringify(requests[i].messages);
        assert.ok(prompt.includes(name));
        assert.ok(prompt.includes('CARD_FORMAT_SENTINEL'));
        assert.ok(prompt.includes('WORLD_FORMAT_SENTINEL'));
        assert.ok(!prompt.includes('ROLE_RESULT_'));
        assert.ok(result.replies[i].includes(`ROLE_RESULT_${i + 1}`));
    });
    emptyReplies = true;
    await page.evaluate(() => document.getElementById('nag-btn-reset').click());
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    await page.evaluate(() => {
        for (const [id, value] of Object.entries({
            'nag-set-prompt': '无响应角色\n不会执行的角色',
            'nag-set-total': '2',
        })) {
            const node = document.getElementById(id);
            node.value = value;
            node.dispatchEvent(new Event('change'));
        }
        document.getElementById('nag-btn-start').click();
    });
    await page.waitForFunction(
        () => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return settings.roleBatch?.items[0]?.failed && !settings.isRunning;
        },
        null,
        { timeout: 30000 },
    );
    const failure = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    assert.equal(requests.length, 6, 'Exactly three empty attempts, no request for the next name');
    assert.equal(failure.index, 0);
    assert.equal(failure.items[1], undefined);
    assert.equal(
        await page.evaluate(() => window.SillyTavern.getContext().chat[2].swipes.length),
        3,
        'Empty attempts must not accumulate candidate pages',
    );
    emptyReplies = false;
    streamError = true;
    await page.evaluate(() => document.getElementById('nag-btn-reset').click());
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    await page.evaluate(() => document.getElementById('nag-btn-start').click());
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].isRunning,
        null,
        { timeout: 30000 },
    );
    const streamFailure = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    assert.equal(streamFailure.index, 0, 'A swallowed streaming error must not count as a generated character');
    assert.equal(streamFailure.items[0].failed, true);
    assert.equal(streamFailure.items[1], undefined);
    assert.equal(requests.length, 9, 'Three streaming failures must stop without processing the next name');
    const afterFailure = await page.evaluate(() => ({
        prompt: window.SillyTavern.getContext().chat[1].mes,
        replies: window.SillyTavern.getContext().chat[2].swipes,
    }));
    assert.deepEqual(afterFailure.replies, result.replies, 'Failed retries must preserve all completed pages');
    assert.equal(afterFailure.prompt, result.prompt);
    const errorRecords = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].errorLog,
    );
    assert.equal(errorRecords.length, 6, 'Only the six failed attempts are recorded');
    assert.ok(errorRecords.every((entry) => entry.phase && entry.attempt && entry.roleIndex === 1));
    assert.ok(!JSON.stringify(errorRecords).includes('ROLE_RESULT_'));
    const downloaded = page.waitForEvent('download');
    await page.locator('#nag-btn-error-log').dispatchEvent('click');
    const download = await downloaded;
    const downloadedLog = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(downloadedLog.errors.length, 6);
    assert.equal(downloadedLog.pluginVersion, '1.9.1-role-batch.3');
    streamError = false;
    await page.evaluate(() => document.getElementById('nag-btn-reset').click());
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    holdResponse = true;
    const held = new Promise((resolve) => {
        onHeld = resolve;
    });
    await page.evaluate(() => document.getElementById('nag-btn-start').click());
    await Promise.race([
        held,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stop-test request did not start')), 15000)),
    ]);
    await page.locator('#mes_stop').dispatchEvent('click');
    holdResponse = false;
    releaseResponse();
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].isRunning,
    );
    await page.evaluate(() => document.getElementById('nag-btn-reset').click());
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    await page.evaluate(() => {
        for (const [id, value] of Object.entries({ 'nag-set-total': '1', 'nag-set-prompt': '停止后重新开始' })) {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new Event('change'));
        }
        document.getElementById('nag-btn-start').click();
    });
    await page.waitForFunction(() => {
        const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
        return !settings.isRunning;
    });
    const restarted = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'],
    );
    assert.equal(restarted.roleBatch.index, 1, 'Manual stop, reset and start must dispatch a fresh request');
    assert.equal(requests.length, 11);
    assert.ok(JSON.stringify(requests[10].messages).includes('停止后重新开始'));
    const restartedReplies = await page.evaluate(() => window.SillyTavern.getContext().chat[2].swipes);
    assert.deepEqual(restartedReplies.slice(0, 3), result.replies);
    assert.ok(restartedReplies.at(-1).includes('ROLE_RESULT_11'));
    assert.equal(restarted.errorLog.length, 6, 'Manual stopping and successful restarting are not errors');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('nag-btn-error-log'));
    assert.equal(
        await page.evaluate(
            () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].errorLog.length,
        ),
        6,
    );
    assert.deepEqual(errors, []);
    console.log(
        JSON.stringify({
            passed: true,
            host: 'SillyTavern',
            requests: requests.length,
            floors: result.floors,
            swipes: result.replies.length,
            cardAndWorldbookPreserved: true,
            previousResultsExcluded: true,
            emptyReplyAttempts: 3,
            streamFailureAttempts: 3,
            manualStopRestart: true,
            nativeSwipeCounterVerified: true,
            errorLogDownload: true,
            model: 'intercepted synthetic responses; no paid model calls',
        }),
    );
} finally {
    await browser.close();
}
