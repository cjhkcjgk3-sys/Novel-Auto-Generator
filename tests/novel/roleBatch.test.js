import { afterEach, expect, it, vi } from 'vitest';
import { createRoleBatchRunner, parseRoleNames } from '../../src/novel/roleBatch.js';

afterEach(() => vi.useRealTimers());
function setup(replies = [{ text: '结果' }]) {
    const settings = { roleNames: '琴\n安柏\n丽莎', totalChapters: 3, replyWaitTime: 0, roleBatch: null };
    const snapshot = { identity: 'chat-a', generating: false };
    let index = 0;
    const host = {
        snapshot: () => snapshot,
        prepareRoleBatch: () => ({ promptFloor: 1, resultFloor: 2, template: '生成 [[角色名]]，名字为 [[角色名]]' }),
        generateRoleReply: vi.fn(async () => {
            const result = replies[Math.min(index++, replies.length - 1)];
            if (result instanceof Error) throw result;
            return result;
        }),
        restoreRoleTemplate: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        notify,
        onChange: vi.fn(),
        onStats: vi.fn(),
    });
    return { settings, host, snapshot, runner, notify };
}

it('substitutes all placeholders in order, preserves duplicate names and caps the list', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    settings.totalChapters = 2;
    settings.roleNames = ' 琴 \n\n琴\n安柏';
    await vi.runAllTimersAsync();
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 琴，名字为 琴',
    ]);
    expect(settings.roleBatch.index).toBe(2);
    expect(settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
    expect(host.restoreRoleTemplate).toHaveBeenCalledWith(settings.roleBatch);
    expect(parseRoleNames(' A\r\n\nB ')).toEqual(['A', 'B']);
});

it('stops at the shorter list and accepts short or unformatted text', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '短' }]);
    settings.roleNames = '琴';
    settings.totalChapters = 100;
    settings.minChapterLength = 10000;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.index).toBe(1);
});

it('retries the same name twice and advances after the third attempt succeeds', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '' }, new Error('network'), { text: '正文' }]);
    settings.totalChapters = 2;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 琴，名字为 琴',
        '生成 琴，名字为 琴',
        '生成 安柏，名字为 安柏',
    ]);
    expect(settings.roleBatch.index).toBe(2);
});

it('marks failure and stops the batch after exactly three empty replies', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '  ' }]);
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(settings.roleBatch.index).toBe(0);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', failed: true });
    expect(settings.roleBatch.items[1]?.processed).not.toBe(true);
    expect(settings.isRunning).toBe(false);
    expect(host.restoreRoleTemplate).toHaveBeenCalledWith(settings.roleBatch);
});

it('marks explicit truncation and continues without retrying that character', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '半截', truncated: true }, { text: '完成' }]);
    settings.totalChapters = 2;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([true, false]);
});

it('does not advance for a truncation signal with no returned text', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '', truncated: true }]);
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(settings.roleBatch.index).toBe(0);
    expect(settings.roleBatch.items[1]?.processed).not.toBe(true);
});

it('keeps uncertain requests pending and does not blindly resend on restart', async () => {
    const { settings, host, runner } = setup([Object.assign(new Error('timeout'), { uncertain: true })]);
    await runner.start();
    await runner.start();
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.pending).toBe(true);
    expect(host.restoreRoleTemplate).not.toHaveBeenCalled();
});

it('pauses between roles and resumes without repeating completed roles', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const task = runner.start();
    await Promise.resolve();
    runner.pause();
    finish({ text: '完成' });
    await vi.advanceTimersByTimeAsync(20);
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    runner.resume();
    await vi.runAllTimersAsync();
    await task;
    expect(settings.roleBatch.index).toBe(3);
});

it('blocks duplicate starts and stops after a chat switch', async () => {
    const { settings, host, snapshot, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const task = runner.start();
    await runner.start();
    snapshot.identity = 'other';
    finish({ text: '迟到的内容' });
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.index).toBe(0);
    expect(settings.roleBatch.pending).toBe(true);
});

it('requires a real placeholder and never sends when preflight fails', async () => {
    const { host, runner, notify } = setup();
    host.prepareRoleBatch = () => ({ template: '没有占位符' });
    await runner.start();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('[[角色名]]'));
});

it('treats names containing replacement symbols as literal text', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    settings.roleNames = '$&';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls[0][1]).toBe('生成 $&，名字为 $&');
});

it('retains the task but does not dispatch when the restored host is disconnected', async () => {
    const { runner, host, snapshot, settings } = setup();
    snapshot.connected = false;
    await runner.start();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(settings.roleBatch.names).toEqual(['琴', '安柏', '丽莎']);
    expect(settings.isRunning).toBe(false);
});

it('marks unclosed role card tags as truncated failure instead of completed', async () => {
    vi.useFakeTimers();
    const unclosedReply = { text: '<character>\n名字：琴\n性格：温柔' };
    const { settings, host, runner } = setup([unclosedReply]);
    settings.totalChapters = 1;
    settings.roleNames = '琴';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', failed: true });
});
