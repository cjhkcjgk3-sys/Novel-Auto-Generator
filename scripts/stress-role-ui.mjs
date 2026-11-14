/** Real Chromium, production UI, synthetic host/data; no model requests or user data.
 * npm install --prefix <tools> playwright jquery
 * PLAYWRIGHT_MODULE=<tools>/node_modules/playwright JQUERY_PATH=<tools>/node_modules/jquery/dist/jquery.js
 * node scripts/stress-role-ui.mjs [report.json]
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '..');
const jquery = process.env.JQUERY_PATH || require.resolve('jquery/dist/jquery.js');
const server = createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            return response.end(
                '<html><head><link rel="stylesheet" href="/style.css"></head><body style="background:#202020;color:#ddd"><div id="extensions_settings"></div><div id="chat"></div><script src="/jquery.js"></script></body></html>',
            );
        }
        if (pathname === '/thumb.svg') {
            response.setHeader('Content-Type', 'image/svg+xml');
            return response.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="gray"/></svg>',
            );
        }
        const file = pathname === '/jquery.js' ? jquery : resolve(root, '.' + pathname);
        if (file !== jquery && !file.startsWith(root + sep)) throw new Error('Invalid path');
        response.setHeader(
            'Content-Type',
            { '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'text/plain',
        );
        response.end(
            await readFile(
                pathname === '/src/novel/runtime.js' && process.env.STRESS_RUNTIME ? process.env.STRESS_RUNTIME : file,
            ),
        );
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise((done) => server.listen(Number(process.env.STRESS_PORT || 0), '127.0.0.1', done));
const browser = await chromium.launch({ channel: process.env.ST_BROWSER_CHANNEL || 'chrome', headless: true });
const reports = [];
try {
    for (const rate of [Number(process.env.STRESS_CPU || 1)]) {
        for (const [count, archiveCount] of [
            [1000, 200],
            [5000, 2000],
            [10000, 10000],
            [30000, 10000],
        ].filter(([count]) => !process.env.STRESS_COUNT || count === Number(process.env.STRESS_COUNT))) {
            const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            const session = await context.newCDPSession(page);
            await session.send('Emulation.setCPUThrottlingRate', { rate });
            await page.evaluate(
                async ({ count, archiveCount }) => {
                    const names = Array.from({ length: count }, (_, i) => `碧蓝航线·角色${i}号`);
                    const items = names.map((name, i) => ({ id: `role-${i}`, name }));
                    window.notices = [];
                    window.toastr = Object.fromEntries(
                        ['info', 'success', 'warning', 'error', 'clear'].map((key) => [
                            key,
                            (text) => window.notices.push([key, text]),
                        ]),
                    );
                    window.saved = null;
                    window.fixture = {
                        generationMode: 'role-batch',
                        roleNames: names.join('\n'),
                        roleArchive: names.slice(0, archiveCount),
                        panelCollapsed: { generate: false, archive: false },
                        roleBatch: {
                            id: 'stress',
                            identity: 'synthetic',
                            template: '生成[[角色名]]',
                            promptFloor: 0,
                            resultFloor: null,
                            names,
                            items,
                            history: [],
                            index: 0,
                        },
                        roleImageLibrary: {
                            workName: '碧蓝航线',
                            workNames: ['碧蓝航线'],
                            items: names.map((name) => ({
                                name,
                                path: '/thumb.svg',
                                thumbPath: '/thumb.svg',
                                aliases: [],
                            })),
                        },
                    };
                    const noop = () => {};
                    window.host = {
                        readSettings: () => window.fixture,
                        writeSettings: (_key, value) => {
                            window.saved = structuredClone(value);
                        },
                        restoreLegacyVisibility: async () => {},
                        snapshot: () => ({ identity: 'synthetic', generating: false, connected: true }),
                        getChat: () => [],
                        getContext: () => ({}),
                        reconcileRoleBatch: async () => {},
                        createRoleResultIsolation: () => ({ refresh: noop, dispose: noop }),
                    };
                    window.ui = (await import('/src/novel/runtime.js')).initNovelUI(window.host);
                },
                { count, archiveCount },
            );
            await page.waitForSelector('#nag-role-results .nag-role-status-row');
            const result = await page.evaluate(async () => {
                const frame = () => new Promise((done) => requestAnimationFrame(done));
                const measure = async (action, repeats = 5) => {
                    const values = [];
                    for (let i = 0; i < repeats; i++) {
                        const start = performance.now();
                        await action(i);
                        document.body.offsetHeight;
                        values.push(performance.now() - start);
                        await frame();
                    }
                    values.sort((a, b) => a - b);
                    return {
                        median: +values[Math.floor(values.length / 2)].toFixed(1),
                        max: +values.at(-1).toFixed(1),
                    };
                };
                const rowCount = () => document.querySelectorAll('#nag-role-results .nag-role-status-row').length;
                const initialRows = rowCount();
                const refresh = await measure(() => $('#nag-set-export-all').trigger('change'));
                const correctionToggle = await measure(() => $('#nag-role-correction-toggle').trigger('click'), 2);
                $('#nag-role-correction-toggle').trigger('click');
                const correction = await measure(async (i) => {
                    document.querySelector('.nag-role-status-set[data-status="failed"]').click();
                    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
                    if (!document.querySelector('.nag-role-status-name').textContent.includes('（手动）'))
                        throw new Error(`Correction did not complete: ${i}`);
                }, 3);
                const expand = await measure(() => $('#nag-role-rows-more').trigger('click'), 4);
                const expandedRows = rowCount();
                const expandedRefresh = await measure(() => $('#nag-set-export-all').trigger('change'));
                const archiveExpand = await measure(() => $('#nag-archive-more').trigger('click'), 4);
                const archiveDelete = await measure(() => document.querySelector('.nag-archive-remove')?.click(), 3);
                // rAF gaps include painting/scheduling; scrolling setters alone do not measure smoothness.
                const gaps = [];
                let lastFrame = await new Promise((done) => requestAnimationFrame(done));
                for (let i = 0; i < 60; i++) {
                    const list = document.querySelector('#nag-role-results');
                    list.style.maxHeight = '300px';
                    list.style.overflowY = 'auto';
                    list.scrollTop = (i / 59) * list.scrollHeight;
                    if (i % 15 === 0) $('#nag-set-export-all').trigger('change');
                    const now = await new Promise((done) => requestAnimationFrame(done));
                    gaps.push(now - lastFrame);
                    lastFrame = now;
                }
                gaps.sort((a, b) => a - b);
                const scroll = {
                    p95FrameGap: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
                    maxFrameGap: +gaps.at(-1).toFixed(1),
                };
                if (document.querySelector('#nag-role-rows-prev')) {
                    const first = document.querySelector('.nag-role-status-set');
                    const target = Number(first.dataset.index);
                    document.querySelector('.nag-role-status-set[data-status="complete"]').click();
                    for (let i = 0; i < 20; i++) await Promise.resolve();
                    if (window.fixture.roleBatch.items[target].manualStatus !== 'complete')
                        throw new Error('Wrong cross-page correction target');
                    const removed = document.querySelector('.nag-archive-name').textContent;
                    document.querySelector('.nag-archive-remove').click();
                    $('#nag-role-rows-prev').trigger('click');
                    const index = Number(document.querySelector('.nag-role-status-set').dataset.index);
                    if (index !== target - 100) throw new Error('Previous page index mismatch');
                    $(window).trigger('pagehide');
                    if (window.saved.roleArchive.includes(removed)) throw new Error('Wrong archive deletion target');
                    if (window.saved.roleBatch.items[target].manualStatus !== 'complete')
                        throw new Error('Correction not persisted');
                }
                return {
                    initialRows,
                    expandedRows,
                    archiveRows: document.querySelectorAll('.nag-archive-row').length,
                    refresh,
                    correctionToggle,
                    correction,
                    expand,
                    expandedRefresh,
                    archiveExpand,
                    archiveDelete,
                    scroll,
                    domNodes: document.querySelectorAll('*').length,
                    warnings: window.notices.filter(([type]) => ['warning', 'error'].includes(type)),
                };
            });
            assert.equal(result.initialRows, process.env.STRESS_RUNTIME ? 200 : 100);
            if (!process.env.STRESS_RUNTIME) {
                assert.equal(result.expandedRows, 100);
                assert.ok(result.archiveRows <= 100);
            }
            assert.deepEqual(result.warnings, []);
            assert.deepEqual(errors, []);
            reports.push({ count, archiveCount, cpuRate: rate, ...result });
            console.log(JSON.stringify(reports.at(-1)));
            if (process.argv[2])
                await writeFile(
                    process.argv[2],
                    JSON.stringify({ browser: browser.version(), reports }, null, 2) + '\n',
                );
            if (process.env.STRESS_SCREENSHOT)
                await page.screenshot({ path: process.env.STRESS_SCREENSHOT, fullPage: true });
            await context.close();
        }
    }
    if (process.argv[2])
        await writeFile(process.argv[2], JSON.stringify({ browser: browser.version(), reports }, null, 2) + '\n');
} finally {
    await browser.close();
    await new Promise((done) => server.close(done));
}
