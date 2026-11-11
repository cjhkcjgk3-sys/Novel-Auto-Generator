import { expect, it, vi } from 'vitest';
import { fixture } from './stRerollFixture.js';
it('does not write to another chat when switching during confirmation', async () => {
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true });
    await r.runner.rerollSelected();
    const other = [
        { mes: 'other greeting' },
        { is_user: true, mes: 'other user' },
        { is_user: false, mes: 'OTHER REAL CHAT', swipes: ['OTHER REAL CHAT'], swipe_info: [{}], swipe_id: 0 },
    ];
    const work = f
        .getHost()
        .acceptRolePreview(f.batch)
        .catch((e) => e);
    f.context.chatId = 'other';
    f.context.chat = other;
    const result = await work;
    expect(result).toBeInstanceOf(Error);
    expect(other[2].mes).toBe('OTHER REAL CHAT');
    expect(f.getDisk()[2].mes).not.toBe('OTHER REAL CHAT');
});

it('does not overwrite another page metadata changed during confirmation', async () => {
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true });
    await r.runner.rerollSelected();
    const message = f.context.chat[2];
    const work = f.getHost().acceptRolePreview(f.batch);
    message.swipe_info[0].extra.userEdit = '保留';
    await expect(work).rejects.toThrow('备选回复已变化');
    expect(message.swipe_info[0].extra.userEdit).toBe('保留');
    expect(message.swipes).toHaveLength(4);
});
it('reports replacement was saved when checkpoint storage fails', async () => {
    let fail = false;
    const map = new Map();
    const storage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => {
            if (fail) throw Error('storage full');
            map.set(k, v);
        },
    };
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true }, storage);
    await r.runner.rerollSelected();
    fail = true;
    await r.runner.acceptPreview();
    expect(f.getDisk()[2].swipes[1]).toContain('乙新');
    expect(r.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('新回复已保存'), expect.anything());
});

it('reports uncertain saves without claiming the replacement did not happen', async () => {
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true });
    await r.runner.rerollSelected();
    vi.spyOn(f.getHost(), 'acceptRolePreview').mockRejectedValue(
        Object.assign(new Error('读取失败'), { uncertain: true }),
    );
    await r.runner.acceptPreview();
    expect(r.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('保存结果未确认'), expect.anything());
    expect(f.batch.preview).not.toBeNull();
});
it('treats a manually accepted invalid candidate as complete after reconciliation', async () => {
    const f = fixture({ isolate: false, selected: 1, newText: '完整但是比较短的角色卡。' });
    const r = f.makeRunner({ rerollConfirm: true, minChapterLength: 100 });
    await r.runner.rerollSelected();
    expect(f.context.chat[2].swipe_info[3].extra.nag_role_batch.status).toBe('invalid');
    await r.runner.acceptPreview();
    expect(f.batch.items[1]).toMatchObject({ failed: false, manualStatus: 'complete' });
    await f.getHost().reconcileRoleBatch(f.batch, { minLength: 100 });
    expect(f.batch.items[1]).toMatchObject({ failed: false, manualStatus: 'complete' });
});

it('keeps 999 other roles intact while comparing and accepting two candidates among 1000 pages', async () => {
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true });
    const message = f.context.chat[2];
    f.batch.names = Array.from({ length: 1000 }, (_, i) => `角色${i}`);
    f.batch.items = f.batch.names.map((name, i) => ({ id: `role${i}`, name, swipe: i, processed: true }));
    r.settings.roleNames = f.batch.names.join('\n');
    message.swipes = f.batch.names.map((name) => `完整原文：${name}。` + '设定。'.repeat(50));
    message.swipe_info = f.batch.items.map((item) => ({
        extra: { nag_role_batch: { taskId: f.batch.id, itemId: item.id, status: 'complete' }, marker: item.name },
    }));
    message.swipe_id = 500;
    message.mes = message.swipes[500];
    message.extra = structuredClone(message.swipe_info[500].extra);
    await f.context.saveChat();
    const oldSwipes = structuredClone(message.swipes);
    const oldInfos = structuredClone(message.swipe_info);
    await r.runner.rerollSelected();
    await r.runner.rerollPreviewAgain();
    expect(f.context.chat[2].swipes).toHaveLength(1002);
    await r.runner.acceptPreview();
    const result = f.context.chat[2];
    expect(result.swipes).toHaveLength(1000);
    expect(result.swipes[500]).not.toBe(oldSwipes[500]);
    for (let i = 0; i < 1000; i++) {
        if (i === 500) continue;
        expect(result.swipes[i]).toBe(oldSwipes[i]);
        expect(result.swipe_info[i]).toEqual(oldInfos[i]);
    }
}, 30000);

it('adds a merged candidate without changing 1000 existing role pages or their metadata', async () => {
    const f = fixture({ isolate: false, selected: 1 });
    const r = f.makeRunner({ rerollConfirm: true });
    const message = f.context.chat[2];
    f.batch.names = Array.from({ length: 1000 }, (_, i) => `角色${i}`);
    f.batch.items = f.batch.names.map((name, i) => ({ id: `role${i}`, name, swipe: i, processed: true }));
    r.settings.roleNames = f.batch.names.join('\n');
    message.swipes = f.batch.names.map((name) => `完整原文：${name}。` + '设定。'.repeat(50));
    message.swipe_info = f.batch.items.map((item) => ({
        extra: { nag_role_batch: { taskId: f.batch.id, itemId: item.id, status: 'complete' }, marker: item.name },
    }));
    message.swipe_id = 500;
    message.mes = message.swipes[500];
    message.extra = structuredClone(message.swipe_info[500].extra);
    await f.context.saveChat();
    await r.runner.rerollSelected();
    const comparison = await f.getHost().getRoleComparison(f.batch);
    const oldSwipes = structuredClone(f.context.chat[2].swipes);
    const oldInfos = structuredClone(f.context.chat[2].swipe_info);
    await f.getHost().saveMergedRolePreview(f.batch, comparison, '合并的完整内容。' + '设定。'.repeat(50));
    expect(f.context.chat[2].swipes).toHaveLength(1002);
    expect(f.context.chat[2].swipes.slice(0, 1001)).toEqual(oldSwipes);
    expect(f.context.chat[2].swipe_info.slice(0, 1001)).toEqual(oldInfos);
}, 30000);
