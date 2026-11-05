import assert from 'node:assert/strict';

/** Runs in the same isolated native host and synthetic transport as the original batch checks. */
export async function runRoleWorkbenchChecks({ page, requests, reopenChat, connect }) {
    const input = async (names) => {
        await page.evaluate(
            (names) => window.jQuery('#nag-set-prompt').val(names).trigger('input').trigger('change'),
            names,
        );
    };
    const state = () =>
        page.evaluate(() => {
            const c = SillyTavern.getContext(),
                s = c.extensionSettings['novel-auto-generator'];
            return {
                names: s.roleNames,
                items: s.roleBatch?.items,
                pages: c.chat[2]?.swipes,
                progress: document.getElementById('nag-progress-text').textContent,
                rows: document.getElementById('nag-role-results').textContent,
            };
        });
    const upload = async (data) => {
        await page.locator('#nag-role-worldbook-file').setInputFiles({
            name: 'fixture-worldbook.json',
            mimeType: 'application/json',
            buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
        });
        await page.waitForFunction(() => !document.getElementById('nag-btn-import-worldbook').disabled);
    };
    const start = async () => {
        await page.locator('#nag-btn-start').dispatchEvent('click');
        await page.waitForFunction(
            () => !SillyTavern.getContext().extensionSettings['novel-auto-generator'].isRunning,
            null,
            { timeout: 60000 },
        );
    };
    const old = {
        uid: 41,
        key: ['旧角色甲', '甲'],
        comment: '旧角色甲',
        content: '<old-format>BOOK_SOURCE_SENTINEL_A',
        order: 57,
        disable: true,
        unknownConfig: { preserved: true },
    };
    const second = { uid: 42, key: ['旧角色乙'], comment: '旧角色乙', content: 'BOOK_SOURCE_SENTINEL_B', order: 58 };
    const world = {
        uid: 1000,
        key: [],
        comment: '世界观 - 保留资料',
        content: 'NON_ROLE_SOURCE_SENTINEL',
        constant: true,
    };
    const book = {
        name: '已有成果',
        customBookField: { preserved: true },
        entries: { 41: old, 42: second, 43: { ...old, uid: 43, content: '重复正文不覆盖已有成果' }, 1000: world },
    };
    await input('');
    await page.evaluate(async () => {
        const toggle = window.jQuery('#nag-set-isolate-result');
        toggle.prop('checked', true);
        await toggle.triggerHandler('change');
    });
    await upload(book);
    let current = await state();
    assert.equal(requests.length, 0);
    assert.equal(current.names, '旧角色甲\n旧角色乙');
    assert.equal(current.items.length, 2);
    assert.ok(current.items.every((item) => item.processed && !item.failed));
    assert.deepEqual(current.pages, [old.content, second.content]);
    assert.ok(current.progress.startsWith('2 / 2'));
    assert.equal(current.rows.split('✅').length - 1, 2);
    await upload(book);
    assert.deepEqual((await state()).pages, current.pages);
    await upload('{bad JSON');
    assert.deepEqual((await state()).pages, current.pages);
    await input('旧角色甲\n旧角色乙\n新角色\n 新角色 \n三月七·存护\n三月七·巡猎\n旧角色甲');
    current = await state();
    assert.equal(current.items.length, 5);
    assert.ok(current.progress.startsWith('2 / 5'));
    await start();
    assert.equal(requests.length, 3);
    current = await state();
    assert.equal(current.pages.length, 5);
    assert.ok(current.items.every((item) => item.processed && !item.failed));
    for (const request of requests) {
        const body = JSON.stringify(request.messages);
        assert.ok(!body.includes('BOOK_SOURCE_SENTINEL'));
        assert.ok(!body.includes('NON_ROLE_SOURCE_SENTINEL'));
        assert.ok(!body.includes('ROLE_RESULT_'));
        assert.ok(body.includes('CARD_FORMAT_SENTINEL') && body.includes('WORLD_FORMAT_SENTINEL'));
    }
    await page.evaluate(async () => {
        await (await import('/script.js')).swipe(null, 'left', { forceMesId: 2, forceSwipeId: 0, forceDuration: 0 });
        await window.jQuery('#nag-btn-reset').triggerHandler('click');
        await (await import('/script.js')).saveSettings();
        await SillyTavern.getContext().saveChat();
    });
    assert.deepEqual((await state()).pages.slice(0, 2), [old.content, second.content]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('nag-btn-start'));
    await reopenChat();
    await connect();
    await start();
    assert.equal(requests.length, 3, 'Reload and reset preserve imported and generated successes');
    const downloaded = page.waitForEvent('download');
    await page.locator('#nag-btn-export-json').dispatchEvent('click');
    const stream = await (await downloaded).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(exported.entries[41], old);
    assert.deepEqual(exported.entries[42], second);
    assert.deepEqual(exported.entries[1000], world);
    assert.equal(Object.keys(exported.entries).length, 6);
    assert.deepEqual(
        Object.values(exported.entries)
            .filter((entry) => entry.uid > 1000)
            .map((entry) => entry.comment),
        ['新角色', '三月七·存护', '三月七·巡猎'],
    );
    assert.ok(
        Object.values(exported.entries)
            .filter((entry) => entry.uid > 1000)
            .every((entry) => entry.disable === false),
    );
    assert.deepEqual(exported.customBookField, { preserved: true });
    await upload(book);
    assert.equal((await state()).pages.length, 5);
    assert.equal(requests.length, 3);
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.locator('#nag-btn-import-worldbook').evaluate((button) => {
        const row = button.parentElement;
        return {
            fits: row.scrollWidth <= row.clientWidth + 1,
            buttons: [...row.querySelectorAll('button')].map((b) => b.textContent),
        };
    });
    assert.ok(layout.fits, 'Import/export controls fit the existing narrow layout');
    return {
        imported: 2,
        uniquePending: 3,
        duplicateImports: true,
        malformedImportPreserved: true,
        nativeSwipes: 5,
        reloadResume: true,
        mergedExportEntries: 6,
        previousResultsExcluded: true,
        narrowLayout: layout.fits,
    };
}
