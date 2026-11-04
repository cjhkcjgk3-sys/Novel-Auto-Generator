import { abortableDelay, throwIfAborted } from '../../txtToWorldbook/core/requestPolicy.js';

export const ROLE_PLACEHOLDER = '[[角色名]]';
export const parseRoleNames = (text) =>
    String(text || '')
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean);

/** One sequential batch, using the existing settings and controls. */
export function createRoleBatchRunner({ getSettings, host, onChange, notify, onStats, onError = () => {} }) {
    let active = null;
    const state = () => getSettings().roleBatch;
    function assertCurrent(run) {
        throwIfAborted(run.controller.signal);
        if (host.snapshot().identity !== run.identity) throw new Error('聊天已切换，批量生成已停止');
    }
    async function start() {
        if (active) return;
        const settings = getSettings();
        const initial = host.snapshot();
        try {
            if (initial.identity == null || initial.generating === true)
                throw new Error('请打开写卡助手聊天，并等待当前生成结束');
            const names = parseRoleNames(settings.roleNames).slice(0, Math.max(1, settings.totalChapters));
            if (!names.length) throw new Error('请在角色名单中每行填写一个名字');
            let batch = state();
            if (batch && batch.identity !== initial.identity) throw new Error('请返回原聊天，或重置批量进度后开始');
            if (batch?.pending) throw new Error('上一轮尚未确认结束，请先查看聊天结果；核对后可手动补生成或重置批次');
            if (!batch) {
                const target = host.prepareRoleBatch();
                if (!target.template.includes(ROLE_PLACEHOLDER))
                    throw new Error(`最后一条用户消息需要包含 ${ROLE_PLACEHOLDER}`);
                batch = settings.roleBatch = {
                    identity: initial.identity,
                    ...target,
                    names,
                    index: 0,
                    attempt: 0,
                    pending: false,
                    items: [],
                };
            }
            if (batch.index >= batch.names.length) {
                notify('info', '名单已处理完毕；新批次请先重置进度');
                return;
            }
        } catch (error) {
            onError(error, { phase: 'prepare' });
            notify('warning', error.message);
            return;
        }

        const run = { identity: initial.identity, controller: new AbortController(), paused: false };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        const stats = { startTime: Date.now(), chaptersGenerated: 0, totalCharacters: 0, errors: [] };
        onStats(stats);
        onChange();
        try {
            const batch = state();
            while (batch.index < batch.names.length) {
                while (run.paused) {
                    await abortableDelay(100, run.controller.signal);
                    assertCurrent(run);
                }
                assertCurrent(run);
                const name = batch.names[batch.index];
                let completed = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    assertCurrent(run);
                    batch.attempt = attempt;
                    batch.items[batch.index] = { name, processing: true };
                    batch.pending = true;
                    onChange();
                    try {
                        const reply = await host.generateRoleReply(
                            batch,
                            batch.template.replaceAll(ROLE_PLACEHOLDER, () => name),
                            {
                                signal: run.controller.signal,
                                assertCurrent: () => assertCurrent(run),
                                timeoutMs: settings.replyTimeoutMs || 600000,
                            },
                        );
                        assertCurrent(run);
                        batch.pending = false;
                        if (!reply.text?.trim()) throw reply.error || new Error('没有返回内容');
                        batch.items[batch.index] = {
                            name,
                            processed: true,
                            failed: !!reply.truncated,
                            swipe: reply.swipe,
                        };
                        if (reply.truncated) stats.errors.push({ chapter: batch.index + 1, error: '内容截断' });
                        batch.index++;
                        stats.chaptersGenerated++;
                        stats.totalCharacters += reply.text?.length || 0;
                        completed = true;
                        onChange();
                        break;
                    } catch (error) {
                        assertCurrent(run);
                        onError(error, {
                            phase: error.phase || 'generate-reply',
                            roleIndex: batch.index + 1,
                            attempt,
                            promptFloor: batch.promptFloor,
                            resultFloor: batch.resultFloor,
                            generating: host.snapshot().generating,
                        });
                        batch.pending = !!error.uncertain;
                        if (error.uncertain || attempt === 3) {
                            batch.items[batch.index] = { name, processed: true, failed: true, error: error.message };
                            throw error;
                        }
                        notify('warning', `${name}：${error.message}，即将进行第 ${attempt + 1}/3 次尝试`);
                        onChange();
                        await abortableDelay(1000, run.controller.signal);
                    }
                }
                if (!completed) break;
                await abortableDelay(Math.max(0, settings.replyWaitTime || 0), run.controller.signal);
            }
            notify('success', '角色批量生成结束，请到写卡助手预览中加载全部设置并导出');
        } catch (error) {
            if (!run.controller.signal.aborted) {
                stats.errors.push({ chapter: state().index + 1, error: error.message });
                notify('warning', error.message);
            }
        } finally {
            const batch = state();
            if (!batch?.pending && host.snapshot().identity === run.identity) {
                try {
                    await host.restoreRoleTemplate?.(batch);
                } catch (error) {
                    onError(error, { phase: 'restore-template' });
                    notify('warning', `恢复提示词模板失败：${error.message}`);
                }
            }
            const item = state()?.items[state().index];
            if (item?.processing) item.processing = false;
            active = null;
            settings.isRunning = false;
            settings.isPaused = false;
            onChange();
        }
    }
    return {
        start,
        pause() {
            if (active) {
                active.paused = true;
                getSettings().isPaused = true;
                onChange();
            }
        },
        resume() {
            if (active) {
                active.paused = false;
                getSettings().isPaused = false;
                onChange();
            }
        },
        stop() {
            active?.controller.abort();
        },
        resetPending() {
            if (!active) {
                getSettings().roleBatch = null;
                onChange();
            }
        },
    };
}
