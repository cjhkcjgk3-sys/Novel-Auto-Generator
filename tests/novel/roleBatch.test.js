import { afterEach, expect, it, vi } from 'vitest';
import { createRoleBatchRunner, parseRoleNames } from '../../src/novel/roleBatch.js';
import {
    applyArchiveSkips,
    countUnidentifiedRolePages,
    duplicateRoleNames,
    mergeRoleArchive,
    normalizeRoleArchive,
    removeRoleArchiveName,
    unidentifiedRolePageSignature,
} from '../../src/novel/roleBatchState.js';

afterEach(() => vi.useRealTimers());

it('detects duplicate full names without merging works, variants or case', () => {
    const names = ' 碧蓝航线·俾斯麦 \n碧蓝航线·俾斯麦Zwei\n其他作品·俾斯麦\n碧蓝航线·俾斯麦\n碧蓝航线·俾斯麦zwei';
    expect(duplicateRoleNames(names)).toEqual(['碧蓝航线·俾斯麦']);
    expect(parseRoleNames(names)).toEqual([
        '碧蓝航线·俾斯麦',
        '碧蓝航线·俾斯麦Zwei',
        '其他作品·俾斯麦',
        '碧蓝航线·俾斯麦zwei',
    ]);
});

it('reports old pages without a reliable role binding and ignores pending preview pages', () => {
    const batch = { id: 'b', items: [{ id: 'a', name: '碧蓝航线·俾斯麦', swipe: 0 }], history: [] };
    const message = {
        swipes: ['已生成', '身份未知', '候选中'],
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'complete' } } },
            {},
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', previewId: 'p' } } },
        ],
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
    expect(countUnidentifiedRolePages(null, message)).toBe(2);
    expect(countUnidentifiedRolePages(null, { mes: '未建立备选页的旧回复' })).toBe(1);
});

it('does not report abandoned retry pages that still name a current role', () => {
    const batch = {
        id: 'b',
        items: [{ id: 'a', name: '碧蓝航线·俾斯麦', swipe: 2, processed: true }],
        history: [],
    };
    const message = {
        swipes: ['第一次尝试（半截）', '...', '成品'],
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'invalid' } } },
            {},
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'complete' } } },
        ],
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(0);
    // A receipt from another batch, or naming a removed role, still needs manual review.
    message.swipe_info[0].extra.nag_role_batch.taskId = 'old-batch';
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
    message.swipe_info[0].extra.nag_role_batch.taskId = 'b';
    message.swipe_info[0].extra.nag_role_batch.itemId = 'missing';
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
});

it('fingerprints unresolved pages by content so reviewed pages are not asked twice', () => {
    const batch = { id: 'b', items: [{ id: 'a', name: '甲', swipe: 0 }], history: [] };
    const message = {
        swipes: ['甲的正文', '未知一', '未知二'],
        swipe_info: [{ extra: { nag_role_batch: { taskId: 'b', itemId: 'a' } } }, {}, {}],
    };
    const before = unidentifiedRolePageSignature(batch, message);
    expect(before).toBeTruthy();
    // Deleting an unrelated known page keeps the fingerprint stable.
    message.swipes.splice(0, 1);
    message.swipe_info.splice(0, 1);
    expect(unidentifiedRolePageSignature(batch, message)).toBe(before);
    // A different unresolved page changes the fingerprint.
    message.swipes.push('未知三');
    message.swipe_info.push({});
    expect(unidentifiedRolePageSignature(batch, message)).not.toBe(before);
    expect(unidentifiedRolePageSignature(batch, {})).toBe('');
});

it('recognizes 1000 recorded role pages without treating distinct names as duplicates', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `id${i}`, name: `作品·角色${i}`, swipe: i }));
    const batch = { id: 'batch', items, history: [] };
    const message = {
        swipes: items.map((item) => `正文 ${item.name}`),
        swipe_info: items.map((item) => ({ extra: { nag_role_batch: { taskId: 'batch', itemId: item.id } } })),
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(0);
    expect(duplicateRoleNames(items.map((item) => item.name).join('\n'))).toEqual([]);
    message.swipe_info[500] = {};
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
});

it('does not generate if the user declines to continue past unidentified old pages', async () => {
    const { host, runner, settings } = setup();
    host.confirmUnidentifiedRolePages = vi.fn(async () => false);
    await runner.start();
    expect(host.confirmUnidentifiedRolePages).toHaveBeenCalledOnce();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(settings.isRunning).toBe(false);
});
it('marks the first batch after a confirmed restart as reviewed, only once', async () => {
    const { host, runner, settings } = setup();
    const seen = [];
    host.confirmUnidentifiedRolePages = vi.fn(async (batch) => {
        seen.push(!!batch.restartReviewed);
        return false;
    });
    await runner.start();
    await runner.resetPending({ restart: true });
    await runner.start();
    expect(settings.roleBatch.restartReviewed).toBe(true);
    await runner.resetPending();
    settings.roleBatch = null;
    await runner.start();
    expect(seen).toEqual([false, true, false]);
});

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
    const archived = vi.fn();
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        notify,
        onChange: vi.fn(),
        onStats: vi.fn(),
        onRoleComplete: archived,
    });
    return { settings, host, snapshot, runner, notify, archived };
}

it('normalizes the finished-role archive by trimmed unique names', () => {
    expect(normalizeRoleArchive([' 琴 ', '琴', '', '安柏', null, { name: ' 丽莎 ' }])).toEqual(['琴', '安柏', '丽莎']);
    expect(normalizeRoleArchive('nope')).toEqual([]);
    expect(mergeRoleArchive(['琴'], ['安柏', ' 琴 ', ''])).toEqual(['琴', '安柏']);
    expect(removeRoleArchiveName(['琴', '安柏'], ' 琴 ')).toEqual(['安柏']);
    expect(removeRoleArchiveName(undefined, '琴')).toEqual([]);
});

it('marks archived names as finished and releases them once deleted from the archive', () => {
    const batch = {
        id: 'b',
        names: ['琴', '安柏'],
        items: [
            { id: 'a', name: '琴' },
            { id: 'b', name: '安柏' },
        ],
        history: [],
    };
    expect(applyArchiveSkips(batch, [' 琴 '])).toEqual(['琴']);
    expect(batch.items[0]).toMatchObject({ archived: true, processed: true, failed: false });
    expect(batch.index).toBe(1);
    expect(applyArchiveSkips(batch, [])).toEqual([]);
    expect(batch.items[0].archived).toBe(false);
    expect(batch.items[0].processed).toBe(false);
    expect(batch.index).toBe(0);
});

it('skips archived names without calling the model and records new completions', async () => {
    vi.useFakeTimers();
    const { settings, host, runner, archived } = setup();
    settings.roleNames = '琴\n安柏';
    settings.roleArchive = ['琴'];
    await vi.runAllTimersAsync();
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual(['生成 安柏，名字为 安柏']);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', archived: true, processed: true });
    expect(settings.roleBatch.index).toBe(2);
    expect(archived.mock.calls.map((call) => call[0])).toEqual(['安柏']);
});

it('substitutes all placeholders and runs each unique full name once with an automatic total', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    settings.totalChapters = 1;
    settings.roleNames = ' 琴 \n\n琴\n安柏';
    await vi.runAllTimersAsync();
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 安柏，名字为 安柏',
    ]);
    expect(settings.roleBatch.index).toBe(2);
    expect(settings.totalChapters).toBe(2);
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
    settings.roleNames = '琴\n安柏';
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
    settings.roleNames = '琴\n安柏';
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

it('accepts complete quoted or HTML-formatted cards for names containing middots and Latin letters', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([
        { text: 'name: "碧蓝航线·俾斯麦Zwei"\ndescription: "完整的人物设定。"' },
        { text: '<character>完整的人物设定<br><portrait type="avatar" /></character>' },
    ]);
    settings.roleNames = '碧蓝航线·俾斯麦Zwei\n碧蓝航线·乌尔里希·冯·胡滕';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([false, false]);
});
