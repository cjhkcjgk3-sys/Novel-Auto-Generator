import { abortableDelay, throwIfAborted } from '../../txtToWorldbook/core/requestPolicy.js';
import { newIdentity } from '../../txtToWorldbook/core/chunkIdentity.js';
import { hydrateRoleBatch, nextRoleIndex, roleComplete, updateRoleNames, parseRoleNames } from './roleBatchState.js';
import { readRoleWorldbook } from './roleWorldbook.js';
import { isRoleCardTruncated } from './tagFilters.js';

export const ROLE_PLACEHOLDER = '[[角色名]]';
export { parseRoleNames } from './roleBatchState.js';

/** One sequential batch, using the existing settings and controls. */
export function createRoleBatchRunner({ getSettings, host, onChange, notify, onStats, onError = () => {}, recovery }) {
    let active = null;
    let preparing = false;
    let restored = false;
    const state = () => getSettings().roleBatch;
    const validationOptions = () => ({
        minLength: getSettings().minChapterLength,
        expectedClosingTags: getSettings().expectedClosingTags,
    });
    function checkpoint() {
        const batch = state();
        try {
            if (batch) {
                batch.updatedAt = Date.now();
                batch.revision = (batch.revision || 0) + 1;
                recovery?.write(batch);
            }
        } catch {
            throw Object.assign(new Error('无法保存批量任务进度，已停止派发；请查看错误日志'), {
                code: 'CHECKPOINT_FAILED',
                uncertain: true,
            });
        }
        try {
            onChange();
        } catch (uiError) {
            onError(uiError, { phase: 'checkpoint-ui' });
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
        if (active || preparing) return;
        getSettings().totalChapters = parseRoleNames(getSettings().roleNames).length;
        if (!batch) return;
        batch.inputNames = getSettings().roleNames;
        batch.inputLimit = getSettings().totalChapters;
        updateRoleNames(batch, parseRoleNames(batch.inputNames));
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
    async function syncEditedTemplate(batch, run) {
        if (!host.readRoleTemplate) return;
        let current = host.readRoleTemplate(batch);
        if (!current.includes(ROLE_PLACEHOLDER)) {
            // A stopped generation can leave its role-substituted prompt in the chat.
            const matches = [...batch.items, ...(batch.history || [])].some(
                (item) => item.name && batch.template.replaceAll(ROLE_PLACEHOLDER, () => item.name) === current,
            );
            if (matches) {
                await host.restoreRoleTemplateIfEquals(batch, current);
                assertCurrent(run);
                current = host.readRoleTemplate(batch);
            }
        }
        if (!current.includes(ROLE_PLACEHOLDER))
            throw new Error(`提示词需要包含 ${ROLE_PLACEHOLDER}，请修改并保存聊天中的提示词`);
        if (current === batch.template) return;
        const previous = batch.template;
        batch.template = current;
        try {
            checkpoint();
        } catch (error) {
            batch.template = previous;
            throw error;
        }
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
            const names = parseRoleNames(settings.roleNames);
            settings.totalChapters = names.length;
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
            if (host.reconcileRoleBatch) await host.reconcileRoleBatch(batch, validationOptions());
            else if (batch.pending) throw new Error('上一轮尚未确认结束，请先查看聊天结果');
            assertCurrent(run);
            await syncEditedTemplate(batch, run);
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
                                validationOptions: validationOptions(),
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
                            failed: Boolean(
                                reply.truncated ||
                                isRoleCardTruncated(reply.text, {
                                    minLength: settings.minChapterLength,
                                    expectedClosingTags: settings.expectedClosingTags,
                                }),
                            ),
                            swipe: reply.swipe,
                        };
                        const truncated =
                            reply.truncated ||
                            isRoleCardTruncated(reply.text, {
                                minLength: settings.minChapterLength,
                                expectedClosingTags: settings.expectedClosingTags,
                            });
                        if (truncated) stats.errors.push({ chapter: batch.index + 1, error: '角色卡未闭合或内容截断' });
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
    async function rerollSelected() {
        if (active || preparing) return;
        preparing = true;
        const settings = getSettings(),
            initial = host.snapshot();
        const run = { identity: initial.identity, controller: new AbortController(), paused: false };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        onChange();
        let batch,
            captured,
            committed = false,
            promptSent = false;
        try {
            restore();
            batch = state();
            if (!batch || batch.identity !== initial.identity) throw new Error('请回到原批次聊天后重试');
            if (initial.generating === true) throw new Error('请先等待酒馆当前生成结束');
            if (initial.connected === false) throw new Error('酒馆 API 尚未连接');
            const previousDispatch = batch.pending && batch.dispatch ? { ...batch.dispatch } : null;
            await host.reconcileRoleBatch(batch, validationOptions());
            assertCurrent(run);
            if (previousDispatch?.itemId) {
                const previousItem = [...batch.items, ...(batch.history || [])].find(
                    (entry) => entry.id === previousDispatch.itemId,
                );
                if (previousItem)
                    await host.restoreRoleTemplateIfEquals?.(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => previousItem.name),
                    );
            }
            await syncEditedTemplate(batch, run);
            assertCurrent(run);
            captured = await host.captureRoleReroll(batch);
            assertCurrent(run);
            batch.pending = true;
            batch.dispatch = { itemId: captured.itemId, attemptId: newIdentity('attempt') };
            checkpoint();
            promptSent = true;
            const reply = await host.generateRoleReply(
                batch,
                batch.template.replaceAll(ROLE_PLACEHOLDER, () => captured.name),
                {
                    signal: run.controller.signal,
                    assertCurrent: () => assertCurrent(run),
                    timeoutMs: settings.replyTimeoutMs || 600000,
                    validationOptions: validationOptions(),
                    expectedPrompt: batch.template,
                },
            );
            assertCurrent(run);
            if (!reply.text?.trim() || reply.truncated || isRoleCardTruncated(reply.text, validationOptions()))
                throw new Error('新回复为空或未完整结束，原角色内容已保留；部分新回复可能保留在末尾');
            const committedResult = await host.commitRoleReroll(batch, captured, reply.swipe);
            committed = true;
            assertCurrent(run);
            const item = [...batch.items, ...(batch.history || [])].find((entry) => entry.id === captured.itemId);
            if (!item) throw Object.assign(new Error('角色记录已变化，请核对聊天'), { uncertain: true });
            Object.assign(item, {
                processing: false,
                processed: true,
                failed: false,
                legacy: false,
                swipe: captured.index,
            });
            batch.pending = false;
            batch.dispatch = null;
            checkpoint();
            if (committedResult?.refreshFailed)
                notify('warning', `${captured.name} 已保存，但页面刷新失败，请重新打开聊天查看`);
            else notify('success', `${captured.name} 已重新生成，其他备选回复已保留`);
        } catch (error) {
            if (batch && captured) batch.pending = !!error.uncertain || run.controller.signal.aborted;
            if (!run.controller.signal.aborted || committed) {
                onError(error, { phase: 'reroll-role' });
                notify(
                    'warning',
                    committed
                        ? `新回复已保存，但后续状态未确认：${error.message}`
                        : `未确认替换，请核对原角色：${error.message}`,
                );
            }
        } finally {
            if (captured && !committed) {
                try {
                    await host.restoreRoleRerollView(captured);
                } catch (error) {
                    onError(error, { phase: 'reroll-restore' });
                }
            }
            if (batch && captured && promptSent && host.snapshot().identity === run.identity) {
                try {
                    await host.restoreRoleTemplateIfEquals(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => captured.name),
                    );
                } catch (error) {
                    onError(error, { phase: 'restore-template' });
                }
            }
            active = null;
            preparing = false;
            settings.isRunning = false;
            settings.isPaused = false;
            if (batch) {
                try {
                    checkpoint();
                } catch (error) {
                    onError(error, { phase: 'save-recovery' });
                }
            } else onChange();
        }
    }
    return {
        start,
        rerollSelected,
        restore,
        saveInput,
        async importWorldbook(data, filename = '') {
            if (active || preparing) throw new Error('请先停止任务，再导入世界书');
            preparing = true;
            const settings = getSettings();
            let previous;
            let committed = false;
            try {
                const imported = readRoleWorldbook(data);
                restore();
                previous = { batch: settings.roleBatch, names: settings.roleNames, total: settings.totalChapters };
                const initial = host.snapshot();
                if (initial.identity == null || initial.generating === true) throw new Error('请先等待酒馆生成结束');
                if (recovery && typeof initial.identity !== 'string')
                    throw new Error('无法可靠识别当前聊天，暂不能保存恢复进度');
                if (state() && state().identity !== initial.identity)
                    throw new Error('请返回原聊天后导入；新建任务请使用“从头生成”');
                if (state()) await host.reconcileRoleBatch(state(), validationOptions());
                const batch = state()
                    ? structuredClone(state())
                    : hydrateRoleBatch({
                          id: newIdentity('role-batch'),
                          identity: initial.identity,
                          ...host.prepareRoleBatch(),
                          names: [],
                          items: [],
                          index: 0,
                          attempt: 0,
                          pending: false,
                      });
                if (!batch.template.includes(ROLE_PLACEHOLDER))
                    throw new Error(`最后一条用户消息需要包含 ${ROLE_PLACEHOLDER}`);
                updateRoleNames(batch, [
                    ...parseRoleNames(settings.roleNames),
                    ...imported.roles.map((role) => role.name),
                ]);
                const roles = imported.roles.flatMap((role) => {
                    const item = batch.items.find((item) => item.name === role.name);
                    return roleComplete(item) ? [] : [{ ...role, item }];
                });
                batch.inputNames = batch.names.join('\n');
                batch.inputLimit = batch.names.length;
                await host.importRoleResults(batch, { ...imported, roles, filename }, () => {
                    batch.index = nextRoleIndex(batch);
                    settings.roleBatch = batch;
                    settings.roleNames = batch.inputNames;
                    settings.totalChapters = batch.names.length;
                    checkpoint();
                    committed = true;
                });
                return {
                    added: roles.length,
                    duplicates: imported.duplicates + imported.roles.length - roles.length,
                    skipped: imported.skipped,
                };
            } catch (error) {
                if (previous && !committed) {
                    settings.roleBatch = previous.batch;
                    settings.roleNames = previous.names;
                    settings.totalChapters = previous.total;
                }
                onError(error, { phase: 'import-worldbook' });
                throw error;
            } finally {
                preparing = false;
                onChange();
            }
        },
        async exportWorldbook() {
            if (active || preparing) throw new Error('请先停止任务，再导出世界书');
            preparing = true;
            try {
                restore();
                const batch = state();
                if (!batch) throw new Error('当前没有角色成果可导出');
                await host.reconcileRoleBatch(batch, validationOptions());
                checkpoint();
                return host.exportRoleWorldbook(batch);
            } catch (error) {
                onError(error, { phase: 'export-worldbook' });
                throw error;
            } finally {
                preparing = false;
            }
        },
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
                    if (!restart) await host.reconcileRoleBatch?.(batch, validationOptions());
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
