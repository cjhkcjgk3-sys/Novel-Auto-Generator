import { expect, it, vi } from 'vitest';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';
import { hydrateRoleBatch, roleComplete, updateRoleNames } from '../../src/novel/roleBatchState.js';

function fixture() {
    const batch = hydrateRoleBatch({
        id: 'batch',
        identity: 'chat',
        template: '写 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        names: ['甲', '乙', '丙'],
        items: ['甲', '乙', '丙'].map((name, i) => ({ id: name, processed: true, failed: false, swipe: i })),
    });
    const settings = { roleBatch: batch, roleNames: '甲\n乙\n丙', replyWaitTime: 0 };
    let saved;
    const host = {
        snapshot: () => ({ identity: 'chat', generating: false, connected: true }),
        reconcileRoleBatch: vi.fn(async (value) => {
            for (const item of value.items)
                if (!item.manualStatus) Object.assign(item, { processed: true, failed: false });
        }),
        generateRoleReply: vi.fn(async () => ({ text: '新角色正文', swipe: 3 })),
        restoreRoleTemplate: vi.fn(async () => {}),
    };
    const recovery = {
        read: () => null,
        write: (value) => {
            saved = structuredClone(value);
        },
    };
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        recovery,
        notify: vi.fn(),
        onChange: vi.fn(),
        onStats: vi.fn(),
    });
    return { batch, settings, host, runner, saved: () => saved };
}

it('persists a manual failure across name removal and re-addition and sends only that role', async () => {
    const f = fixture();
    await f.runner.setRoleStatus(1, 'failed');
    expect(f.saved().items[1].manualStatus).toBe('failed');
    updateRoleNames(f.batch, ['甲', '丙']);
    updateRoleNames(f.batch, ['甲', '丙', '乙']);
    f.settings.roleNames = '甲\n丙\n乙';
    expect(f.batch.items[2]).toMatchObject({ id: '乙', manualStatus: 'failed' });
    await f.runner.start();
    expect(f.host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(f.host.generateRoleReply.mock.calls[0][1]).toBe('写 乙');
    expect(f.batch.items[2]).toMatchObject({ manualStatus: null, processed: true, failed: false, swipe: 3 });
});

it('supports manual completion and returning the role to automatic judgment', async () => {
    const f = fixture();
    await f.runner.setRoleStatus(1, 'complete');
    expect(roleComplete(f.batch.items[1])).toBe(true);
    expect(f.saved().items[1].manualStatus).toBe('complete');
    await f.runner.setRoleStatus(1, 'auto');
    expect(f.batch.items[1].manualStatus).toBeNull();
    expect(roleComplete(f.batch.items[1])).toBe(true);
});

it('rolls back a manual edit if the recovery journal cannot save it', async () => {
    const f = fixture();
    const runner = createRoleBatchRunner({
        getSettings: () => f.settings,
        host: f.host,
        recovery: {
            read: () => null,
            write: () => {
                throw new Error('full');
            },
        },
        notify: vi.fn(),
        onChange: vi.fn(),
        onStats: vi.fn(),
    });
    await expect(runner.setRoleStatus(1, 'failed')).rejects.toThrow('无法保存');
    expect(f.batch.items[1]).toMatchObject({ processed: true, failed: false });
    expect(f.batch.items[1].manualStatus).toBeUndefined();
});

it('prefers a manual correction over older successful records of the same name', () => {
    const f = fixture();
    f.batch.items[1].manualStatus = 'failed';
    f.batch.history.push({ id: 'old', name: '乙', processed: true, failed: false });
    updateRoleNames(f.batch, ['甲', '丙']);
    updateRoleNames(f.batch, ['甲', '丙', '乙']);
    expect(f.batch.items[2]).toMatchObject({ id: '乙', manualStatus: 'failed' });
    expect(roleComplete(f.batch.items[2])).toBe(false);
});
