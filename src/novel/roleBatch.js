import { abortableDelay, throwIfAborted } from '../../txtToWorldbook/core/requestPolicy.js';
import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';
import { hydrateRoleBatch, nextRoleIndex, roleComplete, updateRoleNames } from './roleBatchState.js';

export const ROLE_PLACEHOLDER = '[[角色名]]';
export const parseRoleNames = (text) =>
    String(text || '')
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean);

/** One sequential batch, using the existing settings and controls. */
export function createRoleBatchRunner({ getSettings, host, onChange, notify, onStats, onError = () => {}, recovery }) {
    let active = null;
    let preparing = false;
    let restored = false;
    const state = () => getSettings().roleBatch;
    function checkpoint() {
        const batch = state();
        try {
            if (batch) {
                batch.updatedAt = Date.now();
                batch.revision = (batch.revision || 0) + 1;
                recovery?.write(batch);
            }
            onChange();
        } catch {
            throw Object.assign(new Error('无法保存批量任务进度，已停止派发；请查看错误日志'), {
                code: 'CHECKPOINT_FAILED',
                uncertain: true,
            });
        }
    }
    function restore() {
        if (restored) return;
        const saved = recovery?.read();
        const settings = getSettings();
        if (saved && saved.updatedAt >= (settings.roleBatch?.updatedAt || 0)) {
            settings.roleBatch = saved.cleared ? null : saved;
            if (!saved.cleared) {
                settings.roleNames = saved.inputNames ?? saved.names.join('\n');
                if (settings.generationMode !== 'novel')
                    settings.totalChapters = saved.inputLimit ?? saved.names.length;
            }
        }
        hydrateRoleBatch(settings.roleBatch);
        restored = true;
    }
    function saveInput() {
        const batch = state();
        if (!batch || active || preparing) return;
        batch.inputNames = getSettings().roleNames;
        batch.inputLimit = getSettings().totalChapters;
        try {
            checkpoint();
        } catch (error) {
            onError(error, { phase: 'save-input' });
            notify('warning', error.message);
        }
    }
    function assertCurrent(run) {
        throwIfAborted(run.controller.signal);
        if (host.snapshot().identity !== run.identity) throw new Error('聊天已切换，批量生成已停止');
    }
    async function start() {
        if (active || preparing) return;
        preparing = true;
        const settings = getSettings();
        const initial = host.snapshot();
        const run = { identity: initial.identity, controller: new AbortController(), paused: false };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        const stats = { startTime: Date.now(), chaptersGenerated: 0, totalCharacters: 0, errors: [] };
        onStats(stats);
        onChange();
        let ready = false;
        try {
            restore();
            if (initial.identity == null || initial.generating === true)
                throw new Error('请打开写卡助手聊天，并等待当前生成结束');
            if (recovery && typeof initial.identity !== 'string')
                throw new Error('无法可靠识别当前聊天，暂不能保存恢复进度');
            const names = parseRoleNames(settings.roleNames).slice(0, Math.max(1, settings.totalChapters));
            if (!names.length) throw new Error('请在角色名单中每行填写一个名字');
            let batch = state();
            if (batch && batch.identity !== initial.identity)
                throw new Error('请返回原聊天继续；要在当前聊天新建批次，请先使用“从头生成”');
            if (!batch) {
                const target = host.prepareRoleBatch();
                if (!target.template.includes(ROLE_PLACEHOLDER))
                    throw new Error(`最后一条用户消息需要包含 ${ROLE_PLACEHOLDER}`);
                batch = settings.roleBatch = {
                    id: newIdentity('role-batch'),
                    identity: initial.identity,
                    ...target,
                    names,
                    index: 0,
                    attempt: 0,
                    pending: false,
                    items: [],
                };
                hydrateRoleBatch(batch);
            }
            if (host.reconcileRoleBatch) await host.reconcileRoleBatch(batch);
            else if (batch.pending) throw new Error('上一轮尚未确认结束，请先查看聊天结果');
            assertCurrent(run);
            updateRoleNames(batch, names);
            batch.inputNames = settings.roleNames;
            batch.inputLimit = settings.totalChapters;
            checkpoint();
            if (batch.index >= batch.names.length) {
                notify('info', '名单已全部完成，已有成品已跳过；需要重做请用“从头生成”');
                return;
            }
            if (host.snapshot().connected === false) throw new Error('酒馆 API 尚未连接，请连接后继续任务');
            ready = true;
        } catch (error) {
            if (!run.controller.signal.aborted) {
                onError(error, { phase: 'prepare' });
                notify('warning', error.message);
            }
            return;
        } finally {
            preparing = false;
            if (!ready) {
                active = null;
                settings.isRunning = false;
                settings.isPaused = false;
                onChange();
            }
        }
        try {
            const batch = state();
            while (batch.index < batch.names.length) {
                while (run.paused) {
                    await abortableDelay(100, run.controller.signal);
                    assertCurrent(run);
                }
                assertCurrent(run);
                if (roleComplete(batch.items[batch.index])) {
                    batch.index++;
                    continue;
                }
                const name = batch.names[batch.index];
                let completed = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    assertCurrent(run);
                    batch.attempt = attempt;
                    batch.items[batch.index] = { ...batch.items[batch.index], name, processing: true };
                    batch.pending = true;
                    batch.dispatch = { itemId: batch.items[batch.index].id, attemptId: newIdentity('attempt') };
                    checkpoint();
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
                            ...batch.items[batch.index],
                            name,
                            legacy: false,
                            processing: false,
                            processed: true,
                            failed: !!reply.truncated,
                            swipe: reply.swipe,
                        };
                        if (reply.truncated) stats.errors.push({ chapter: batch.index + 1, error: '内容截断' });
                        batch.index++;
                        batch.dispatch = null;
                        stats.chaptersGenerated++;
                        stats.totalCharacters += reply.text?.length || 0;
                        completed = true;
                        checkpoint();
                        break;
                    } catch (error) {
                        assertCurrent(run);
                        if (error.code === 'CHECKPOINT_FAILED') throw error;
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
                            batch.items[batch.index] = {
                                ...batch.items[batch.index],
                                name,
                                processed: true,
                                failed: true,
                                error: error.message,
                            };
                            throw error;
                        }
                        notify('warning', `${name}：${error.message}，即将进行第 ${attempt + 1}/3 次尝试`);
                        checkpoint();
                        await abortableDelay(1000, run.controller.signal);
                    }
                }
                if (!completed) break;
                await abortableDelay(Math.max(0, settings.replyWaitTime || 0), run.controller.signal);
            }
            const remaining = batch.items.filter((item) => !roleComplete(item)).length;
            notify(
                remaining ? 'warning' : 'success',
                remaining
                    ? `本轮结束，仍有 ${remaining} 项未完成；点击开始继续补齐`
                    : '角色批量生成结束，请到写卡助手预览中加载全部设置并导出',
            );
        } catch (error) {
            if (!run.controller.signal.aborted) {
                if (error.code === 'CHECKPOINT_FAILED') onError(error, { phase: 'save-recovery' });
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
            try {
                checkpoint();
            } catch (error) {
                onError(error, { phase: 'save-recovery' });
                notify('warning', error.message);
            }
        }
    }
    return {
        start,
        restore,
        saveInput,
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
        async resetPending({ restart = false } = {}) {
            if (active || preparing) return;
            preparing = true;
            try {
                const batch = state();
                if (batch && (!restart || batch.identity === host.snapshot().identity)) {
                    if (!restart) await host.reconcileRoleBatch?.(batch);
                    await host.restoreRoleTemplate?.(batch);
                }
                if (restart) {
                    recovery?.clear();
                    getSettings().roleBatch = null;
                    restored = true;
                    onChange();
                } else if (batch) {
                    hydrateRoleBatch(batch);
                    batch.index = nextRoleIndex(batch);
                    checkpoint();
                }
            } finally {
                preparing = false;
            }
        },
    };
}
