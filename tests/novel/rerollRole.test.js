import { expect, it, vi } from 'vitest';
import { createRoleBatchRunner } from '../../src/novel/roleBatch.js';

function fixture(result = { text: '新角色正文', swipe: 3 }) {
    const batch = {
        id: 'task',
        identity: '1:chat',
        template: '创建 [[角色名]]',
        promptFloor: 1,
        resultFloor: 2,
        names: ['甲', '乙', '丙'],
        index: 3,
        pending: false,
        items: [
            { id: 'a', name: '甲', swipe: 0, processed: true },
            { id: 'b', name: '乙', swipe: 1, processed: true },
            { id: 'c', name: '丙', swipe: 2, processed: true },
        ],
        history: [],
    };
    const settings = { roleBatch: batch, roleNames: batch.names.join('\n'), totalChapters: 3, minChapterLength: 0 };
    const capture = {
        identity: batch.identity,
        floor: 2,
        itemId: 'b',
        name: '乙',
        index: 1,
        baseline: { swipes: ['甲原文', '乙原文', '丙原文'] },
    };
    const host = {
        snapshot: () => ({ identity: batch.identity, generating: false, connected: true }),
        reconcileRoleBatch: vi.fn(async () => {}),
        captureRoleReroll: vi.fn(async () => capture),
        generateRoleReply: vi.fn(async () => result),
        commitRoleReroll: vi.fn(async () => 1),
        restoreRoleRerollView: vi.fn(async () => true),
        restoreRoleTemplate: vi.fn(async () => {}),
        restoreRoleTemplateIfEquals: vi.fn(async () => true),
    };
    const notify = vi.fn(),
        onError = vi.fn();
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        onChange: vi.fn(),
        notify,
        onStats: vi.fn(),
        onError,
    });
    return { batch, settings, host, notify, onError, runner };
}

it('regenerates only the selected role using its own name and retains the other bindings', async () => {
    const { batch, settings, host, runner } = fixture();
    await runner.rerollSelected();
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(host.generateRoleReply.mock.calls[0][1]).toBe('创建 乙');
    expect(host.commitRoleReroll).toHaveBeenCalledOnce();
    expect(batch.items.map((item) => [item.name, item.swipe])).toEqual([
        ['甲', 0],
        ['乙', 1],
        ['丙', 2],
    ]);
    expect(batch.pending).toBe(false);
    expect(settings.isRunning).toBe(false);
});

it('never commits an empty or truncated response', async () => {
    for (const result of [
        { text: '', swipe: null },
        { text: '半截', swipe: 3, truncated: true },
    ]) {
        const { batch, host, runner } = fixture(result);
        await runner.rerollSelected();
        expect(host.commitRoleReroll).not.toHaveBeenCalled();
        expect(host.restoreRoleRerollView).toHaveBeenCalledOnce();
        expect(batch.items.map((item) => item.swipe)).toEqual([0, 1, 2]);
    }
});

it('does not restore over a user-edited prompt when preflight rejects it', async () => {
    const { host, runner } = fixture();
    host.captureRoleReroll.mockRejectedValue(new Error('原始提示词已变化'));
    await runner.rerollSelected();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(host.restoreRoleTemplateIfEquals).not.toHaveBeenCalled();
    expect(host.restoreRoleTemplate).not.toHaveBeenCalled();
});

it('does not claim success when saving or verification cannot be confirmed', async () => {
    const { batch, host, notify, runner } = fixture();
    host.commitRoleReroll.mockRejectedValue(Object.assign(new Error('保存未确认'), { uncertain: true }));
    await runner.rerollSelected();
    expect(batch.items[1].swipe).toBe(1);
    expect(batch.pending).toBe(true);
    expect(notify).not.toHaveBeenCalledWith('success', expect.anything());
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('保存未确认'));
});

it('reports a refresh failure accurately after saving rather than claiming the old response remains', async () => {
    const { host, notify, runner } = fixture();
    host.commitRoleReroll.mockResolvedValue({ index: 1, refreshFailed: true });
    await runner.rerollSelected();
    expect(host.restoreRoleRerollView).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('已保存'));
});
