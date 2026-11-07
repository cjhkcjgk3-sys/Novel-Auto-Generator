import { expect, it, vi } from 'vitest';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';
import { hydrateRoleBatch } from '../../src/novel/roleBatchState.js';

function fixture(prompt = '新版 [[角色名]]，补充细节') {
    const batch = hydrateRoleBatch({
        id: 'task',
        identity: 'chat',
        promptFloor: 1,
        resultFloor: 2,
        template: '旧版 [[角色名]]',
        names: ['甲', '乙'],
        items: [{ id: 'a', processed: true, swipe: 0 }, { id: 'b' }],
    });
    const settings = { roleBatch: batch, roleNames: '甲\n乙', replyWaitTime: 0 };
    let current = prompt;
    const writes = [];
    const host = {
        snapshot: () => ({ identity: 'chat', generating: false, connected: true }),
        readRoleTemplate: () => current,
        reconcileRoleBatch: vi.fn(async () => {}),
        restoreRoleTemplateIfEquals: vi.fn(async (_batch, expected) => {
            if (current === expected) current = batch.template;
        }),
        restoreRoleTemplate: vi.fn(async () => {}),
        generateRoleReply: vi.fn(async () => ({ text: '乙正文', swipe: 1 })),
        captureRoleReroll: vi.fn(async () => ({ name: '甲', itemId: 'a', index: 0 })),
        commitRoleReroll: vi.fn(async () => ({ index: 0 })),
        restoreRoleRerollView: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const recovery = { read: () => null, write: (value) => writes.push(structuredClone(value)) };
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        recovery,
        notify,
        onChange: vi.fn(),
        onStats: vi.fn(),
    });
    return { batch, settings, host, writes, notify, runner, getPrompt: () => current };
}

it('saves a changed chat template before continuing only the remaining role', async () => {
    const f = fixture();
    await f.runner.start();
    expect(f.host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(f.host.generateRoleReply.mock.calls[0][1]).toBe('新版 乙，补充细节');
    expect(f.batch.items[0]).toMatchObject({ id: 'a', processed: true, swipe: 0 });
    expect(f.writes.find((entry) => entry.pending)?.template).toBe('新版 [[角色名]]，补充细节');
});

it('uses the edited template for a single-role regeneration', async () => {
    const f = fixture();
    await f.runner.rerollSelected();
    expect(f.host.generateRoleReply.mock.calls[0][1]).toBe('新版 甲，补充细节');
    expect(f.host.generateRoleReply.mock.calls[0][2].expectedPrompt).toBe('新版 [[角色名]]，补充细节');
});

it('leaves a user edit without the required placeholder intact and sends no request', async () => {
    const f = fixture('我修改的提示词');
    await f.runner.start();
    expect(f.host.generateRoleReply).not.toHaveBeenCalled();
    expect(f.getPrompt()).toBe('我修改的提示词');
    expect(f.batch.template).toBe('旧版 [[角色名]]');
    expect(f.notify).toHaveBeenCalledWith('warning', expect.stringContaining('[[角色名]]'));
});

it('restores a known role-substituted prompt left by interrupted generation', async () => {
    const f = fixture('旧版 甲');
    await f.runner.start();
    expect(f.host.restoreRoleTemplateIfEquals).toHaveBeenCalledWith(f.batch, '旧版 甲');
    expect(f.host.generateRoleReply.mock.calls[0][1]).toBe('旧版 乙');
});

it('does not dispatch if the edited template cannot be saved to the recovery journal', async () => {
    const f = fixture();
    const runner = createRoleBatchRunner({
        getSettings: () => f.settings,
        host: f.host,
        recovery: {
            read: () => null,
            write: () => {
                throw new Error('storage unavailable');
            },
        },
        notify: f.notify,
        onChange: vi.fn(),
        onStats: vi.fn(),
    });
    await runner.start();
    expect(f.host.generateRoleReply).not.toHaveBeenCalled();
    expect(f.batch.template).toBe('旧版 [[角色名]]');
    expect(f.getPrompt()).toBe('新版 [[角色名]]，补充细节');
});
