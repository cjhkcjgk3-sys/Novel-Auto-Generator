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
    const requests = [];
    let emptyReplies = false;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const endpoint of ['text-models', 'text-workers'])
        await page.route(`**/api/horde/${endpoint}`, (route) => route.fulfill({ json: [] }));
    await page.route('**/api/horde/status', (route) => route.fulfill({ json: { ok: false } }));
    await page.route('**/api/backends/chat-completions/status', (route) =>
        route.fulfill({ json: { data: [{ id: 'fixture-model' }] } }),
    );
    await page.route('**/api/backends/chat-completions/generate', (route) => {
        const body = route.request().postDataJSON();
        requests.push(body);
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
    await page.locator('#main_api').selectOption('openai', { force: true });
    await page.locator('#chat_completion_source').selectOption('custom', { force: true });
    await page.locator('#custom_api_url_text').fill('http://127.0.0.1:18080/v1', { force: true });
    await page.locator('#custom_api_url_text').dispatchEvent('input');
    await page.locator('#custom_model_id').fill('fixture-model', { force: true });
    await page.locator('#custom_model_id').dispatchEvent('input');
    await page.locator('#api_button_openai').dispatchEvent('click');
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
        document.getElementById('nag-btn-start').click();
    });
    await page
        .waitForFunction(
            () => {
                const settings = SillyTavern.getContext().extensionSettings['novel-auto-generator'];
                return settings.roleBatch?.index === 3 && !settings.isRunning;
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
    assert.equal(result.floors, 3);
    assert.equal(result.replies.length, 3);
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
            model: 'intercepted synthetic responses; no paid model calls',
        }),
    );
} finally {
    await browser.close();
}
