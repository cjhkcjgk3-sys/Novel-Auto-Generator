import { afterEach, expect, it, vi } from 'vitest';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';
import { createRoleBatchRecoveryStore } from '../../src/novel/recoveryStore.js';
import { hydrateRoleBatch, updateRoleNames } from '../../src/novel/roleBatchState.js';

afterEach(() => vi.useRealTimers());
function fixture() {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const recovery = createRoleBatchRecoveryStore(() => storage);
    const receipts = new Map();
    const host = {
        snapshot: () => ({ identity: 'chat-a', generating: false }),
        prepareRoleBatch: () => ({ promptFloor: 1, resultFloor: 2, template: '生成 [[角色名]]' }),
        restoreRoleTemplate: vi.fn(async () => {}),
        reconcileRoleBatch: vi.fn(async (batch) => {
            for (const item of batch.items)
                if (receipts.has(item.id))
                    Object.assign(item, { processed: true, failed: false, swipe: receipts.get(item.id) });
            batch.pending = false;
        }),
        generateRoleReply: vi.fn(async (batch) => {
            const stored = recovery.read();
            expect(stored.pending).toBe(true);
            expect(stored.dispatch.itemId).toBe(batch.items[batch.index].id);
            const swipe = receipts.size;
            receipts.set(batch.items[batch.index].id, swipe);
            return { text: '正文', swipe };
        }),
    };
    const create = (settings = { roleNames: '琴\n安柏\n丽莎', totalChapters: 3, replyWaitTime: 0 }) => {
        const runner = createRoleBatchRunner({
            getSettings: () => settings,
            host,
            recovery,
            onChange: vi.fn(),
            onStats: vi.fn(),
            notify: vi.fn(),
        });
        return { settings, runner };
    };
    return { values, storage, recovery, receipts, host, create };
}
async function run(runner) {
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
}

it('restores a stopped batch from the existing journal and skips already completed roles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.create();
    const generate = f.host.generateRoleReply.getMockImplementation();
    f.host.generateRoleReply.mockImplementationOnce(async (...args) => {
        first.runner.pause();
        return generate(...args);
    });
    const task = first.runner.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(first.settings.roleBatch.index).toBe(1);
    first.runner.stop();
    await vi.runAllTimersAsync();
    await task;
    const second = f.create();
    await run(second.runner);
    expect(f.host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual(['生成 琴', '生成 安柏', '生成 丽莎']);
    expect(second.settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
});

it('reconciles a chat receipt saved before the progress checkpoint without a duplicate request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const batch = hydrateRoleBatch({
        identity: 'chat-a',
        names: ['琴', '安柏'],
        template: '生成 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        pending: true,
        items: [],
        updatedAt: Date.now(),
    });
    batch.dispatch = { itemId: batch.items[0].id, attemptId: 'saved-before-crash' };
    f.receipts.set(batch.items[0].id, 0);
    f.recovery.write(batch);
    await run(f.create().runner);
    expect(f.host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual(['生成 安柏']);
});

it('reset retains completed rows while an explicit restart clears progress even with stale settings', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { runner, settings } = f.create();
    await run(runner);
    const oldSettings = structuredClone(settings);
    await runner.resetPending();
    await run(runner);
    expect(f.host.generateRoleReply).toHaveBeenCalledTimes(3);
    await runner.resetPending({ restart: true });
    const reopened = f.create(oldSettings);
    reopened.runner.restore();
    expect(reopened.settings.roleBatch).toBeNull();
    await run(reopened.runner);
    expect(f.host.generateRoleReply).toHaveBeenCalledTimes(6);
});

it('name edits retain completed occurrences, support reorder, removal and later re-addition', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { runner, settings } = f.create({ roleNames: '琴\n琴', totalChapters: 2 });
    await run(runner);
    settings.roleNames = '琴\n安柏\n琴';
    settings.totalChapters = 3;
    runner.saveInput();
    expect(settings.roleBatch.names).toEqual(['琴', '安柏', '琴']);
    expect(settings.roleBatch.items.map((item) => !!item.processed)).toEqual([true, false, true]);
    await run(runner);
    expect(f.host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual(['生成 琴', '生成 琴', '生成 安柏']);
    const batch = settings.roleBatch;
    const ids = batch.items.map((item) => item.id);
    updateRoleNames(batch, ['安柏']);
    updateRoleNames(batch, ['琴', '琴', '安柏']);
    expect(batch.items.map((item) => item.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(batch.items.every((item) => item.processed)).toBe(true);
});

it('removes edited-out rows immediately, persists an empty list and retains completion on re-addition', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { runner, settings } = f.create();
    await run(runner);
    const ids = settings.roleBatch.items.map((item) => item.id);
    settings.roleBatch.items[1].failed = true;
    settings.roleNames = '丽莎\n琴\n新增角色';
    runner.saveInput();
    expect(settings.roleBatch.names).toEqual(['丽莎', '琴', '新增角色']);
    expect(settings.roleBatch.items.map((item) => item.id).slice(0, 2)).toEqual([ids[2], ids[0]]);
    expect(settings.roleBatch.history.some((item) => item.name === '安柏' && item.failed)).toBe(true);
    expect(f.recovery.read().names).toEqual(settings.roleBatch.names);
    settings.roleNames = '';
    runner.saveInput();
    const reopened = f.create();
    reopened.runner.restore();
    expect(reopened.settings.roleBatch.names).toEqual([]);
    expect(reopened.settings.roleBatch.items).toEqual([]);
    reopened.settings.roleNames = '琴\n丽莎';
    reopened.settings.totalChapters = 2;
    reopened.runner.saveInput();
    await run(reopened.runner);
    expect(f.host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(reopened.settings.roleBatch.items.map((item) => item.id)).toEqual([ids[0], ids[2]]);
});

it('storage failure prevents dispatch, and corrupt recovery is not silently used', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.storage.setItem = () => {
        throw new Error('quota');
    };
    await run(f.create().runner);
    expect(f.host.generateRoleReply).not.toHaveBeenCalled();
    const broken = fixture();
    broken.values.set('novel-auto-generator:role-batch:v1', '{bad');
    await run(broken.create().runner);
    expect(broken.host.generateRoleReply).not.toHaveBeenCalled();
});
