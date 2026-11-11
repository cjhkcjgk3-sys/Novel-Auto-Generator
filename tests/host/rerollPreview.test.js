import { expect, it } from 'vitest';
import { CARD, fixture } from './stRerollFixture.js';

const versions = (n) => CARD(`乙新${n}`);
const memoryStorage = () => {
    const data = new Map();
    return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
};
const ORIGINAL = [CARD('甲'), CARD('乙'), CARD('丙')];

function setup(options = {}) {
    const f = fixture({ isolate: false, selected: 1, newText: versions, ...options });
    const storage = memoryStorage();
    const r = f.makeRunner({ rerollConfirm: true }, storage);
    return { f, r, storage, message: () => f.context.chat[2] };
}

it('keeps the original page untouched and leaves the new version as a pending tail candidate', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    expect(message().swipes).toEqual([...ORIGINAL, versions(1)]);
    expect(message().swipe_id).toBe(3);
    expect(f.batch.preview).toMatchObject({ itemId: 'role1', name: '乙', index: 1, count: 3 });
    expect(f.batch.items[1].swipe).toBe(1);
    expect(f.getDisk()[2].swipes).toEqual(message().swipes);
    expect(r.notify).toHaveBeenCalledWith('success', expect.stringContaining('候选版本'), expect.anything());
    // the candidate is never treated as the role's result
    await f.getHost().reconcileRoleBatch(f.batch, { minLength: 100 });
    expect(f.batch.items[1]).toMatchObject({ swipe: 1, processed: true, failed: false });
});

it('appends another candidate on every “再生成一版” and keeps all of them for comparison', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    await r.runner.rerollPreviewAgain();
    await r.runner.rerollPreviewAgain();
    expect(message().swipes).toEqual([...ORIGINAL, versions(1), versions(2), versions(3)]);
    expect(f.getHost().rolePreview(f.batch).candidates).toEqual([3, 4, 5]);
    expect(message().swipe_id).toBe(5);
    expect(f.batch.preview).not.toBeNull();
});

it('compares the selected candidate with the original without modifying any page', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    await r.runner.rerollPreviewAgain();
    await f.getHost().showRolePage(2, 3, f.batch.identity);
    const before = structuredClone(message());
    expect(await f.getHost().getRoleComparison(f.batch)).toMatchObject({
        original: ORIGINAL[1],
        candidate: versions(1),
        originalIndex: 1,
        candidateIndex: 3,
    });
    expect(message()).toEqual(before);
    await f.getHost().showRolePage(2, 1, f.batch.identity);
    expect(await f.getHost().getRoleComparison(f.batch)).toMatchObject({
        original: ORIGINAL[1],
        candidate: versions(2),
        candidateIndex: 4,
    });
});

it('saves a merge as a new candidate without changing original or other candidates', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    const comparison = await f.getHost().getRoleComparison(f.batch);
    const before = structuredClone(message().swipes);
    await f.getHost().saveMergedRolePreview(f.batch, comparison, CARD('合并后'));
    expect(message().swipes.slice(0, before.length)).toEqual(before);
    expect(message().swipes[4]).toBe(CARD('合并后'));
    expect(f.getDisk()[2].swipes).toEqual(message().swipes);
    expect(message().swipe_id).toBe(4);
    expect(f.batch.preview).not.toBeNull();
    await r.runner.acceptPreview();
    expect(message().swipes).toEqual([ORIGINAL[0], CARD('合并后'), ORIGINAL[2]]);
});

it('refuses to save a merge after the candidate or chat has changed', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    const comparison = await f.getHost().getRoleComparison(f.batch);
    message().swipes[3] = '用户更新的候选';
    await expect(f.getHost().saveMergedRolePreview(f.batch, comparison, CARD('合并后'))).rejects.toThrow('已变化');
    expect(message().swipes).toHaveLength(4);
});

it('never saves a merged candidate to a different chat if the user switches mid-check', async () => {
    const { f, r } = setup();
    await r.runner.rerollSelected();
    const comparison = await f.getHost().getRoleComparison(f.batch);
    const other = [
        { mes: 'other' },
        { is_user: true, mes: 'other' },
        { mes: '其他聊天', swipes: ['其他聊天'], swipe_info: [{}], swipe_id: 0 },
    ];
    const work = f.getHost().saveMergedRolePreview(f.batch, comparison, CARD('合并后'));
    f.context.chatId = 'other';
    f.context.chat = other;
    await expect(work).rejects.toThrow(/聊天|变化/);
    expect(other[2].mes).toBe('其他聊天');
});

it('never overwrites another page changed while a merge is being checked', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    const comparison = await f.getHost().getRoleComparison(f.batch);
    const work = f.getHost().saveMergedRolePreview(f.batch, comparison, CARD('合并后'));
    message().swipe_info[0].extra.userEdit = '保留此修改';
    await expect(work).rejects.toThrow('已变化');
    expect(message().swipe_info[0].extra.userEdit).toBe('保留此修改');
    expect(message().swipes).toHaveLength(4);
});

it('rejects a comparison if the original changes during the integrity check', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    const work = f.getHost().getRoleComparison(f.batch);
    message().swipes[1] = '用户编辑了原版';
    await expect(work).rejects.toThrow(/变化|修改/);
    expect(message().swipes[1]).toBe('用户编辑了原版');
});

it('accepts the displayed candidate into the original position and removes the other candidates', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    await r.runner.rerollPreviewAgain();
    await f.getHost().showRolePage(2, 3, f.batch.identity); // user swipes back to the first candidate
    await r.runner.acceptPreview();
    expect(message().swipes).toEqual([ORIGINAL[0], versions(1), ORIGINAL[2]]);
    expect(message().swipe_info).toHaveLength(3);
    expect(message().swipe_id).toBe(1);
    expect(message().mes).toBe(versions(1));
    expect(message().swipe_info[1].extra.nag_role_batch).toMatchObject({ itemId: 'role1', status: 'complete' });
    expect(message().swipe_info[1].extra.nag_role_batch.previewId).toBeUndefined();
    expect(f.getDisk()[2].swipes).toEqual(message().swipes);
    expect(f.batch.preview).toBeNull();
    expect(f.batch.items[1]).toMatchObject({ swipe: 1, processed: true, failed: false });
    expect(r.notify).toHaveBeenLastCalledWith('success', expect.stringContaining('已替换为所选版本'));
});

it('refuses to accept while an original page is displayed or after an original page was edited', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    await f.getHost().showRolePage(2, 0, f.batch.identity);
    await r.runner.acceptPreview();
    expect(r.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('请先切换'), expect.anything());
    message().swipes[2] = '用户改过的丙';
    await f.getHost().showRolePage(2, 3, f.batch.identity);
    await r.runner.acceptPreview();
    expect(r.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('原有备选回复'), expect.anything());
    expect(message().swipes[1]).toBe(ORIGINAL[1]);
    expect(f.batch.preview).not.toBeNull();
});

it('discards all candidates and returns to the untouched original page', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    await r.runner.rerollPreviewAgain();
    await r.runner.discardPreview();
    expect(message().swipes).toEqual(ORIGINAL);
    expect(message().swipe_info).toHaveLength(3);
    expect(message().swipe_id).toBe(1);
    expect(message().mes).toBe(ORIGINAL[1]);
    expect(f.getDisk()[2].swipes).toEqual(ORIGINAL);
    expect(f.batch.preview).toBeNull();
});

it('with “重生成后手动确认” off, replaces the role automatically exactly as before', async () => {
    const f = fixture({ isolate: false, selected: 1, newText: versions });
    const r = f.makeRunner({ rerollConfirm: false });
    await r.runner.rerollSelected();
    expect(f.context.chat[2].swipes).toEqual([ORIGINAL[0], versions(1), ORIGINAL[2]]);
    expect(f.batch.preview ?? null).toBeNull();
    expect(r.notify).toHaveBeenCalledWith('success', '乙 已重新生成，其他备选回复已保留');
});

it('keeps a pending preview across a page reload and still accepts it afterwards', async () => {
    const { f, r, storage, message } = setup();
    await r.runner.rerollSelected();
    const reloaded = f.reload(storage, { rerollConfirm: true });
    expect(reloaded.settings.roleBatch.preview).toMatchObject({ name: '乙', index: 1, count: 3 });
    expect(reloaded.runner.previewPending()).toBe(true);
    // conflicting operations are blocked with a clear message
    await reloaded.runner.rerollSelected();
    expect(reloaded.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('待确认'), expect.anything());
    await reloaded.runner.start();
    expect(reloaded.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('待确认'));
    expect(message().swipes).toHaveLength(4);
    await reloaded.runner.acceptPreview();
    expect(message().swipes).toEqual([ORIGINAL[0], versions(1), ORIGINAL[2]]);
    expect(reloaded.settings.roleBatch.preview).toBeNull();
});

it('ends the preview when the user deleted every trial page by hand', async () => {
    const { f, r, message } = setup();
    await r.runner.rerollSelected();
    const m = message();
    m.swipes.splice(3, 1);
    m.swipe_info.splice(3, 1);
    m.swipe_id = 1;
    m.mes = m.swipes[1];
    m.extra = structuredClone(m.swipe_info[1].extra);
    await r.runner.discardPreview();
    expect(f.batch.preview).toBeNull();
    expect(message().swipes).toEqual(ORIGINAL);
    r.settings.rerollConfirm = false;
    await r.runner.rerollSelected();
    expect(message().swipes[1]).toBe(versions(2));
});

it('a failed trial generation leaves the original untouched and ends an empty preview', async () => {
    const { f, r, message } = setup();
    f.setApi('streamError');
    await r.runner.rerollSelected();
    expect(message().swipes).toEqual(ORIGINAL);
    expect(message().swipe_id).toBe(1);
    expect(f.batch.preview).toBeNull();
    expect(r.notify).toHaveBeenLastCalledWith('warning', expect.stringContaining('原角色页未改动'), expect.anything());
});

it('with result isolation on, an accepted candidate is re-sealed and still validates as the role result', async () => {
    const { f, r, message } = setup({ isolate: true });
    await r.runner.rerollSelected();
    await r.runner.acceptPreview();
    expect(message().swipes[1]).toBe(versions(1));
    expect(message().swipe_info[1].extra.nag_result_hash).toBeTruthy();
    await f.getHost().reconcileRoleBatch(f.batch, { minLength: 100 });
    expect(f.batch.items[1]).toMatchObject({ swipe: 1, processed: true, failed: false });
});
