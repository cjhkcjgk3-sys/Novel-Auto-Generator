import { describe, expect, it } from 'vitest';
import { fixture } from './stRerollFixture.js';

describe('first reroll on a clean floor (ST 1.19 swipe/stream semantics)', () => {
    for (const isolate of [false, true])
        for (const streaming of [true, false])
            for (const selected of [0, 1, 2])
                it(`isolate=${isolate} streaming=${streaming} page=${selected}`, async () => {
                    const f = fixture({ isolate, streaming, selected });
                    await expect(f.reroll()).resolves.toMatchObject({ index: selected });
                    const m = f.context.chat[2];
                    expect(m.swipes.length).toBe(3);
                    expect(m.swipe_id).toBe(selected);
                    expect(m.mes).toContain('乙新');
                });
    for (const selected of [0, 1, 2])
        it(`isolate=true pre-sealed page=${selected}`, async () => {
            const f = fixture({ isolate: true, selected });
            await f.iso.prepare();
            await expect(f.reroll()).resolves.toMatchObject({ index: selected });
        });
    it('api error: host reverts, error names it, floor stays clean, next reroll works', async () => {
        const f = fixture({ isolate: false, selected: 0, api: 'error' });
        await expect(f.reroll()).rejects.toThrow('酒馆生成后退回旧候选页');
        const m = f.context.chat[2];
        expect(m.swipe_id).toBe(0);
        expect(m.swipe_info.length).toBe(m.swipes.length);
    });
    it('stream error: "..." page is discarded and view returns to the original page', async () => {
        const f = fixture({ isolate: false, selected: 1, api: 'streamError' });
        await expect(f.reroll()).rejects.toThrow();
        const m = f.context.chat[2];
        expect(m.swipe_id).toBe(1);
        expect(m.swipes.length).toBe(3);
    });
    for (const oldSync of [false, true])
        for (const selected of [0, 1])
            it(`full runner: oldSync(ST<=1.16)=${oldSync} page=${selected}`, async () => {
                const f = fixture({ isolate: false, selected, oldSync });
                const { notify } = await f.runnerReroll();
                const m = f.context.chat[2];
                expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('已重新生成'));
                expect(m.swipes.length).toBe(3);
                expect(m.swipe_id).toBe(selected);
                expect(m.mes).toContain('新');
            });
});

it('full runner on ST<=1.16 (no targetMessage in syncSwipeToMes) shows and saves the new text', async () => {
    const f = fixture({ isolate: false, selected: 1, oldSync: true });
    const { notify } = await f.runnerReroll();
    expect(notify).toHaveBeenCalledWith('success', '乙 已重新生成，其他备选回复已保留');
    expect(f.context.chat[2].mes).toContain('乙新');
    expect(f.getDisk()[2].mes).toContain('乙新');
    expect(f.context.chat[2].swipes.length).toBe(3);
});

it('retries when ST silently skips the commit save (chat save busy)', async () => {
    const f = fixture({ isolate: false, selected: 1, skipSaves: 1 });
    const { notify } = await f.runnerReroll();
    const m = f.context.chat[2];
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('已重新生成'));
    expect(m.swipes.length).toBe(3);
    expect(m.swipes[1]).toContain('乙新');
    expect(m.swipe_id).toBe(1);
});
