import { createRoleSelectionUI } from '../host/roleSelection.js';
import { buildRoleMergePlan, mergeRolePlan, renderRoleComparison, validateRoleMerge } from './roleComparison.js';
import { createBufferedStream } from '../host/bufferedStream.js';
import { createNovelRecoveryStore, createRoleBatchRecoveryStore } from './recoveryStore.js';
import {
    countUnidentifiedRolePages,
    duplicateRoleNames,
    mergeRoleArchive,
    normalizeRoleArchive,
    removeRoleArchiveName,
    roleComplete,
    updateRoleNames,
} from './roleBatchState.js';
import { createNovelRunner } from './generation.js';
import { createRoleBatchRunner, parseRoleNames } from './roleBatch.js';
import { createListRenderer } from '../../txtToWorldbook/ui/renderer.js';
import { createErrorRecord } from '../../txtToWorldbook/core/logger.js';
import { parseTagInput, extractTagContents, removeTagContents, applyTagFilters } from './tagFilters.js';
import {
    addNamesToRoster,
    clearRoleImageLibrary,
    getRoleImageForRequest,
    hasChecklistRoles,
    importRoleImageZip,
    isRoleImageDisabled,
    listChecklistRoles,
    matchRoleImage,
    setRoleImageDisabled,
} from './roleImageLibrary.js';

let instance = null;
export function initNovelUI(host) {
    if (instance) return instance;
    let refreshTimer;
    let disposed = false;
    let cleanupHelp = null;
    let fileOperation = false;
    let roleCorrection = false;
    const extensionName = 'novel-auto-generator';

    const defaultSettings = {
        totalChapters: 1000,
        currentChapter: 0,
        prompt: '继续推进剧情，保证剧情流畅自然，注意人物性格一致性',
        generationMode: 'novel',
        roleNames: '',
        roleBatch: null,
        roleImageLibrary: null,
        // 已完成角色名录（全局共用）：生成名单里出现这个名字时自动跳过，避免重复生成。
        roleArchive: [],
        errorLog: [],
        isRunning: false,
        isPaused: false,

        // 发送检测设置
        enableSendToastDetection: true,
        sendToastWaitTimeout: 60000,
        sendPostToastWaitTime: 1000,

        // 回复等待设置
        replyWaitTime: 5000,
        stabilityCheckInterval: 1000,
        stabilityRequiredCount: 3,
        enableReplyToastDetection: true,
        replyToastWaitTimeout: 300000,
        replyPostToastWaitTime: 2000,

        // 生成设置
        autoSaveInterval: 50,
        maxRetries: 3,
        minChapterLength: 100,

        // 仅隔离当前批次的结果楼层，保留原生备选数据及纯文本查看。
        isolateRoleResult: false,
        // 单角色重生成先在末尾生成候选版本，由用户确认后才替换原页；关闭则生成完成后自动替换。
        rerollConfirm: true,
        bufferModelStream: false,

        // 导出设置
        exportAll: true,
        exportStartFloor: 0,
        exportEndFloor: 99999,
        exportIncludeUser: false,
        exportIncludeAI: true,
        useRawContent: true,
        extractTags: '',
        excludeTags: '',
        extractMode: 'all',
        tagSeparator: '\n\n',

        panelCollapsed: {
            generate: false,
            archive: true,
            export: false,
            extract: true,
            advanced: true,
        },
    };

    let settings = {};
    let resultIsolation = null;
    let roleSelection = null;
    let generationStats = { startTime: null, chaptersGenerated: 0, totalCharacters: 0, errors: [] };
    let recordedStatErrors = 0;
    let roleSuccessNotices = [];
    const pluginVersion = '1.15.1';
    function recordError(error, details = {}) {
        if (['ABORTED', 'USER_STOPPED'].includes(error?.code)) return;
        const entries = Array.isArray(settings.errorLog) ? settings.errorLog : [];
        settings.errorLog = [...entries, createErrorRecord(error, { mode: settings.generationMode, ...details })].slice(
            -100,
        );
        try {
            saveSettings();
        } catch {
            /* Logging must not interrupt generation. */
        }
    }

    // ============================================
    // 工具函数
    // ============================================

    function log(msg, type = 'info') {
        const p = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' }[type] || 'ℹ️';
        console.log(`[NovelGen] ${p} ${msg}`);
    }

    function formatDuration(ms) {
        if (!ms || ms < 0) return '--:--:--';
        const s = Math.floor(ms / 1000) % 60,
            m = Math.floor(ms / 60000) % 60,
            h = Math.floor(ms / 3600000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, '<br>');
    }

    function escapeAttribute(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => {
            const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            return escaped[character];
        });
    }

    // ============================================
    // SillyTavern 数据访问
    // ============================================

    const getSTChat = () => host.getChat();

    function getTotalFloors() {
        const c = getSTChat();
        return c ? c.length : document.querySelectorAll('#chat .mes').length;
    }

    function getMaxFloorIndex() {
        const total = getTotalFloors();
        return total > 0 ? total - 1 : 0;
    }

    function getRawMessages(startFloor, endFloor, opts = {}) {
        const { includeUser = false, includeAI = true } = opts;
        const stChat = getSTChat();
        if (!stChat) return null;

        const messages = [];
        const start = Math.max(0, startFloor);
        const end = Math.min(stChat.length - 1, endFloor);

        for (let i = start; i <= end; i++) {
            const msg = stChat[i];
            if (!msg) continue;
            const isUser = msg.is_user || msg.is_human || false;
            if (isUser && !includeUser) continue;
            if (!isUser && !includeAI) continue;
            const rawContent = msg.mes || '';
            if (rawContent) {
                messages.push({ floor: i, isUser, name: msg.name || (isUser ? 'User' : 'AI'), content: rawContent });
            }
        }
        return messages;
    }

    // ============================================
    // 标签提取
    // ============================================

    // ============================================
    // 章节获取
    // ============================================

    function getAllChapters() {
        const extractTags = parseTagInput(settings.extractTags);
        const excludeTags = parseTagInput(settings.excludeTags);
        const useTagExtract = settings.extractMode === 'tags' && extractTags.length > 0;
        const useTagFilters = useTagExtract || excludeTags.length > 0;
        const chapters = [];

        const startFloor = settings.exportAll ? 0 : settings.exportStartFloor;
        const endFloor = settings.exportAll ? getMaxFloorIndex() : settings.exportEndFloor;

        if (settings.useRawContent) {
            const rawMessages = getRawMessages(startFloor, endFloor, {
                includeUser: settings.exportIncludeUser,
                includeAI: settings.exportIncludeAI,
            });

            if (rawMessages?.length) {
                for (const msg of rawMessages) {
                    const content = useTagFilters
                        ? applyTagFilters(msg.content, {
                              extractTags,
                              excludeTags,
                              extractMode: settings.extractMode,
                              separator: settings.tagSeparator,
                          })
                        : msg.content;
                    if (!content && useTagFilters) continue;
                    if (content?.length > 10) {
                        chapters.push({
                            floor: msg.floor,
                            index: chapters.length + 1,
                            isUser: msg.isUser,
                            name: msg.name,
                            content,
                        });
                    }
                }
                return chapters;
            }
        }

        document.querySelectorAll('#chat .mes').forEach((msg, idx) => {
            if (idx < startFloor || idx > endFloor) return;
            const isUser = msg.getAttribute('is_user') === 'true';
            if (isUser && !settings.exportIncludeUser) return;
            if (!isUser && !settings.exportIncludeAI) return;
            const text = (
                msg.querySelector('.mes_text')?.innerText || msg.querySelector('.mes_text')?.textContent
            )?.trim();
            if (!text) return;
            const content = useTagFilters
                ? applyTagFilters(text, {
                      extractTags,
                      excludeTags,
                      extractMode: settings.extractMode,
                      separator: settings.tagSeparator,
                  })
                : text;
            if (content?.length > 10) {
                chapters.push({ floor: idx, index: chapters.length + 1, isUser, content });
            }
        });
        return chapters;
    }

    // ============================================
    // 帮助弹窗
    // ============================================

    function showHelp(topic) {
        const helps = {
            generate: {
                title: '📝 生成设置说明',
                content: `
<h4>📌 目标章节</h4>
<p>设置要自动生成的章节总数（同楼层批量生成模式下为目标角色总数）。</p>
<h4>📌 提示词</h4>
<p>每次自动发送给 AI 的消息内容（批量生成模式下为角色列表）。</p>
<h4>📌 隔离写卡结果</h4>
<p>仅针对当前批次的结果楼层：当前页及前后各一页豁免显示隔离，沿用酒馆原生预览与渲染；未选中候选保留为原生数据，不额外挂载页面。三页豁免不改变模型上下文，旧角色卡仍被排除，预设、命令及上方消息照常使用。原文校验继续有效，主动编辑前请关闭开关，重新开启时建立新的校验基线。</p>
            `,
            },
            export: {
                title: '📤 导出设置说明',
                content: `
<h4>📌 楼层范围</h4>
<p>楼层从 <b>0</b> 开始计数。</p>
<h4>📌 原始 (chat.mes)</h4>
<ul>
    <li><b>✅ 勾选</b>：读取原始内容</li>
    <li><b>❌ 不勾选</b>：读取显示内容（经过正则处理）</li>
</ul>
            `,
            },
            extract: {
                title: '🏷️ 标签提取说明',
                content: `
<h4>📌 什么是标签提取？</h4>
<p>从 AI 回复的原始内容中，只提取指定 XML 标签内的文字。</p>
<h4>📌 使用场景</h4>
<p>当你使用正则美化输出时，原始回复可能包含：</p>
<pre>&lt;思考&gt;AI的思考过程...&lt;/思考&gt;
&lt;content&gt;这是正文内容...&lt;/content&gt;</pre>
<p>使用标签提取可以只导出 &lt;content&gt; 内的正文。</p>
<h4>📌 如何使用</h4>
<ol>
    <li>✅ 勾选「原始 (chat.mes)」</li>
    <li>若要白名单提取，模式选择「标签」并填写要提取的标签名</li>
    <li>若只想移除杂项，可保持「全部内容」并填写要移除的标签名</li>
    <li>白名单提取与黑名单移除可以同时使用</li>
</ol>
<h4>📌 多标签</h4>
<p>用空格、逗号分隔：<code>content detail 正文</code></p>
<h4>📌 黑名单移除</h4>
<p>移除标签会删除对应标签及其内部内容，建议同样勾选「原始 (chat.mes)」，并可与白名单提取同时使用。</p>
<pre>&lt;thinking&gt;思考...&lt;/thinking&gt;
&lt;content&gt;正文&lt;/content&gt;</pre>
<p>若移除 <code>thinking</code>，预览和导出将只保留其他内容。</p>
<h4>📌 调试</h4>
<p>控制台输入 <code>nagDebug()</code></p>
            `,
            },
            advanced: {
                title: '⚙️ 高级设置说明',
                content: `
<h4>📤 发送阶段</h4>
<p>消息发送后，可能有其他插件（如剧情推进插件）需要处理消息。</p>
<ul>
    <li><b>弹窗检测</b>：检测到弹窗时等待其消失，确保其他插件处理完成</li>
    <li><b>等待超时</b>：最长等待弹窗消失的时间</li>
    <li><b>额外等待</b>：弹窗消失后再等待的时间</li>
</ul>

<h4>📥 回复阶段</h4>
<p>AI回复完成后，可能有总结插件需要处理内容。</p>
<ul>
    <li><b>回复后等待</b>：AI回复稳定后等待的时间，让总结插件有时间启动</li>
    <li><b>稳定检查间隔</b>：检查内容是否稳定的间隔</li>
    <li><b>稳定次数</b>：内容需要连续多少次不变才算稳定</li>
    <li><b>弹窗检测</b>：检测总结插件的弹窗，等待其完成</li>
</ul>

<h4>🔧 生成控制</h4>
<ul>
    <li><b>自动保存间隔</b>：每生成多少章自动导出一次</li>
    <li><b>最大重试</b>：单章生成失败的最大重试次数</li>
    <li><b>最小长度</b>：AI回复少于此字数视为失败</li>
</ul>
            `,
            },
        };

        const helpData = helps[topic] || { title: '帮助', content: '<p>暂无帮助内容</p>' };

        cleanupHelp?.();
        // 移除已存在的弹窗
        const existingModal = document.getElementById('nag-help-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // 创建弹窗容器
        const modalContainer = document.createElement('div');
        modalContainer.className = 'nag-modal-container';
        modalContainer.id = 'nag-help-modal';
        modalContainer.innerHTML = `
        <div class="nag-modal">
            <div class="nag-modal-header">
                <span class="nag-modal-title">${helpData.title}</span>
                <button class="nag-modal-close" type="button">✕</button>
            </div>
            <div class="nag-modal-body">${helpData.content}</div>
        </div>
    `;

        // 关闭弹窗函数
        const closeModal = (e) => {
            if (e) {
                e.stopPropagation();
                e.preventDefault();
            }
            modalContainer.remove();
            document.removeEventListener('keydown', escHandler, true);
        };

        // ESC 关闭 - 使用捕获阶段，优先处理
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();
                closeModal();
            }
        };
        cleanupHelp = () => closeModal();
        document.addEventListener('keydown', escHandler, true);

        // 关闭按钮点击
        modalContainer.querySelector('.nag-modal-close').addEventListener(
            'click',
            (e) => {
                closeModal(e);
            },
            false,
        );

        // 阻止弹窗内部点击冒泡
        modalContainer.querySelector('.nag-modal').addEventListener(
            'click',
            (e) => {
                e.stopPropagation();
            },
            false,
        );

        modalContainer.querySelector('.nag-modal').addEventListener(
            'mousedown',
            (e) => {
                e.stopPropagation();
            },
            false,
        );

        modalContainer.querySelector('.nag-modal').addEventListener(
            'touchstart',
            (e) => {
                e.stopPropagation();
            },
            { passive: true },
        );

        // 点击容器背景关闭
        modalContainer.addEventListener(
            'click',
            (e) => {
                if (e.target === modalContainer) {
                    closeModal(e);
                }
            },
            false,
        );

        modalContainer.addEventListener(
            'mousedown',
            (e) => {
                if (e.target === modalContainer) {
                    e.stopPropagation();
                }
            },
            false,
        );

        modalContainer.addEventListener(
            'touchstart',
            (e) => {
                e.stopPropagation();
            },
            { passive: true },
        );

        // 添加到 body 最后，确保在最顶层
        document.body.appendChild(modalContainer);

        // 强制重新计算位置（修复某些浏览器的渲染问题）
        requestAnimationFrame(() => {
            modalContainer.style.opacity = '1';
        });
    }

    // ============================================
    // 预览
    // ============================================

    function refreshPreview() {
        const stChat = getSTChat();
        const extractTags = parseTagInput(settings.extractTags);
        const excludeTags = parseTagInput(settings.excludeTags);
        const useTagExtract = settings.extractMode === 'tags' && extractTags.length > 0;
        const useTagExclude = excludeTags.length > 0;

        if (!stChat || stChat.length === 0) {
            $('#nag-preview-content').html(`<div class="nag-preview-warning"><b>⚠️ 无法获取聊天数据</b></div>`);
            return;
        }

        let rawContent = '',
            floor = -1;
        for (let i = stChat.length - 1; i >= 0; i--) {
            const msg = stChat[i];
            if (msg && !msg.is_user && !msg.is_human && msg.mes) {
                rawContent = msg.mes;
                floor = i;
                break;
            }
        }

        if (!rawContent) {
            $('#nag-preview-content').html('<i style="opacity:0.6">没有 AI 消息</i>');
            return;
        }

        const rawPreview = rawContent.substring(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = `
        <div class="nag-preview-source">楼层 ${floor} | 长度 ${rawContent.length} 字</div>
        <div class="nag-preview-raw">${rawPreview}${rawContent.length > 200 ? '...' : ''}</div>
    `;

        if (useTagExtract || useTagExclude) {
            let previewText = rawContent;
            if (useTagExtract) {
                previewText = extractTagContents(rawContent, extractTags, settings.tagSeparator);
                if (!previewText) {
                    html += `<div class="nag-preview-warning"><b>⚠️ 未找到标签</b> [${escapeHtml(extractTags.join(', '))}]</div>`;
                    $('#nag-preview-content').html(html);
                    return;
                }
            }

            if (useTagExclude) {
                previewText = removeTagContents(previewText, excludeTags);
            } else {
                previewText = previewText.trim();
            }

            if (previewText) {
                const actions = [];
                if (useTagExtract) actions.push(`提取标签 [${escapeHtml(extractTags.join(', '))}]`);
                if (useTagExclude) actions.push(`移除标签 [${escapeHtml(excludeTags.join(', '))}]`);
                html += `<div class="nag-preview-success"><b>✅ ${actions.join(' + ')}</b> (${previewText.length} 字)<div class="nag-preview-text">${escapeHtml(previewText.slice(0, 400))}</div></div>`;
            } else {
                html += `<div class="nag-preview-warning"><b>⚠️ 移除标签后没有可预览内容</b></div>`;
            }
        } else {
            html += `<div class="nag-preview-info"><b>📄 全部内容模式</b></div>`;
        }

        $('#nag-preview-content').html(html);
    }

    function debugRawContent(floorIndex) {
        const stChat = getSTChat();
        if (!stChat) {
            console.log('❌ 无法获取 chat');
            return;
        }

        console.log(`✅ chat 获取成功，共 ${stChat.length} 条`);

        if (floorIndex === undefined) {
            for (let i = stChat.length - 1; i >= 0; i--) {
                if (stChat[i] && !stChat[i].is_user) {
                    floorIndex = i;
                    break;
                }
            }
        }

        const msg = stChat[floorIndex];
        if (!msg) {
            console.log(`楼层 ${floorIndex} 不存在`);
            return;
        }

        console.log(`\n----- 楼层 ${floorIndex} -----`);
        console.log('mes:', msg.mes?.substring(0, 500));

        const extractTags = parseTagInput(settings.extractTags);
        const excludeTags = parseTagInput(settings.excludeTags);
        if (extractTags.length > 0 || excludeTags.length > 0) {
            console.log(`\n----- 标签处理 -----`);
            if (extractTags.length > 0) {
                console.log(`提取标签: [${extractTags.join(', ')}]`);
                console.log('提取结果:', extractTagContents(msg.mes, extractTags, '\n---\n') || '(无匹配)');
            }
            if (excludeTags.length > 0) {
                console.log(`移除标签: [${excludeTags.join(', ')}]`);
                console.log('移除结果:', removeTagContents(msg.mes, excludeTags) || '(移除后为空)');
            }
            console.log(
                '最终结果:',
                applyTagFilters(msg.mes, {
                    extractTags,
                    excludeTags,
                    extractMode: settings.extractMode,
                    separator: settings.tagSeparator,
                }) || '(无结果)',
            );
        }
    }

    window.nagDebug = debugRawContent;

    // ============================================
    // 弹窗检测
    // ============================================

    const bufferedStream = createBufferedStream({
        enabled: () => settings.isRunning && settings.bufferModelStream,
        onError: (error) => recordError(error, { phase: 'buffered-stream' }),
    });
    const novelRunner = createNovelRunner({
        recovery: createNovelRecoveryStore(() => localStorage),
        getSettings: () => settings,
        snapshot: host.snapshot,
        send: host.send,
        onChange: () => {
            for (const entry of generationStats.errors.slice(recordedStatErrors))
                recordError(new Error(entry.error), { phase: 'auto-novel', roleIndex: entry.chapter });
            recordedStatErrors = generationStats.errors.length;
            saveSettings();
            updateUI();
        },
        notify: (type, message) => toastr[type](message),
        exportNovel: (...args) => exportNovel(...args),
        onStats: (stats) => {
            generationStats = stats;
            recordedStatErrors = 0;
        },
    });
    const roleRunner = createRoleBatchRunner({
        recovery: createRoleBatchRecoveryStore(() => localStorage),
        getSettings: () => settings,
        host,
        onError: recordError,
        onChange: () => {
            saveSettings();
            updateUI();
        },
        notify: (type, message, options) => {
            const notice = toastr[type](message, undefined, options);
            if (type === 'success' && notice) roleSuccessNotices = [...roleSuccessNotices, notice].slice(-5);
            return notice;
        },
        onStats: (stats) => {
            generationStats = stats;
        },
        onRoleComplete: (name) => {
            // onChange/saveSettings follows every checkpoint, so this is persisted with the batch.
            settings.roleArchive = mergeRoleArchive(settings.roleArchive, [name]);
        },
    });
    resultIsolation = host.createRoleResultIsolation({
        getBatch: () =>
            settings.generationMode === 'role-batch' && settings.isolateRoleResult ? settings.roleBatch : null,
        getRoleImage: (request) => {
            const batch = settings.roleBatch;
            if (
                settings.generationMode !== 'role-batch' ||
                !batch ||
                host.snapshot().identity !== batch.identity ||
                batch.id !== request?.taskId ||
                batch.dispatch?.itemId !== request.itemId ||
                batch.dispatch?.attemptId !== request.attemptId
            )
                return null;
            const item = [...(batch.items || []), ...(batch.history || [])].find(
                (candidate) => candidate.id === request.itemId,
            );
            return item ? getRoleImageForRequest(item.name, settings.roleImageLibrary) : null;
        },
        restoreLegacyVisibility: () => host.restoreLegacyVisibility(),
        onError: (error, details) => {
            recordError(error, details);
            toastr.warning(error.message);
        },
    });
    const currentRunner = () => (settings.generationMode === 'role-batch' ? roleRunner : novelRunner);
    const roleStatusRenderer = createListRenderer();

    async function startGeneration() {
        if (fileOperation) return;
        try {
            if (settings.bufferModelStream) await bufferedStream.probe();
            await resultIsolation.prepare();
        } catch (error) {
            recordError(error, { phase: 'result-integrity' });
            toastr.warning(error.message);
            return;
        }
        if (settings.generationMode === 'role-batch') {
            const currentPrompt = $('#nag-set-prompt').val();
            if (typeof currentPrompt === 'string') settings.roleNames = currentPrompt;
            roleRunner.saveInput();
        }
        return currentRunner().start();
    }
    async function rerollCurrentRole() {
        if (settings.isRunning || fileOperation) return;
        fileOperation = true;
        updateUI();
        try {
            if (settings.bufferModelStream) await bufferedStream.probe();
            await roleRunner.rerollSelected();
        } catch (error) {
            recordError(error, { phase: 'reroll-prepare' });
            toastr.warning(error.message);
        } finally {
            fileOperation = false;
            updateUI();
        }
    }
    async function runRoleAction(action, phase) {
        if (settings.isRunning || fileOperation) return;
        fileOperation = true;
        updateUI();
        try {
            await action();
        } catch (error) {
            recordError(error, { phase });
            toastr.warning(error.message);
        } finally {
            fileOperation = false;
            updateUI();
        }
    }
    function pauseGeneration() {
        currentRunner().pause();
        toastr.info('当前章节结束后暂停');
    }
    function resumeGeneration() {
        currentRunner().resume();
        toastr.info('已恢复');
    }
    function stopGeneration() {
        currentRunner().stop();
        toastr.warning('已停止自动续写；酒馆正在生成的回复可能仍会完成');
    }

    async function resetProgress({ restart = false } = {}) {
        if (settings.isRunning || fileOperation) {
            toastr.warning('请先停止');
            return;
        }
        if (settings.generationMode === 'role-batch') {
            $(
                '#nag-btn-start, #nag-btn-reset, #nag-btn-restart-role, #nag-set-mode, #nag-set-prompt, #nag-set-total',
            ).prop('disabled', true);
            try {
                await roleRunner.resetPending({ restart });
            } catch (error) {
                recordError(error, { phase: 'reset-task' });
                toastr.warning(error.message);
                return;
            } finally {
                updateUI();
            }
        } else currentRunner().resetPending();
        if (settings.generationMode !== 'role-batch') settings.currentChapter = 0;
        generationStats = { startTime: null, chaptersGenerated: 0, totalCharacters: 0, errors: [] };
        saveSettings();
        updateUI();
        toastr.info(
            settings.generationMode === 'role-batch'
                ? restart
                    ? '已清除完成进度，点击开始从头生成；已有回复保留'
                    : '已重置运行状态，完成记录已保留；点击开始继续'
                : '已重置',
        );
    }

    // ============================================
    // 导出
    // ============================================

    function downloadFile(content, filename, type = 'text/plain') {
        const blob = new Blob([content], { type: `${type};charset=utf-8` });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async function verifyExportResults() {
        try {
            await resultIsolation?.verify();
            return true;
        } catch (error) {
            recordError(error, { phase: 'result-integrity' });
            toastr.warning(error.message);
            return false;
        }
    }

    async function exportNovel(silent = false) {
        if (!(await verifyExportResults())) return;
        const chapters = getAllChapters();
        if (!chapters.length) {
            if (!silent) toastr.warning('没有内容');
            return;
        }

        const totalChars = chapters.reduce((s, c) => s + c.content.length, 0);
        let text = `导出时间: ${new Date().toLocaleString()}\n总章节: ${chapters.length}\n总字数: ${totalChars}\n${'═'.repeat(40)}\n\n`;
        chapters.forEach((ch) => {
            text += `══ [${ch.floor}楼] ${ch.isUser ? '用户' : 'AI'} ══\n\n${ch.content}\n\n`;
        });

        downloadFile(text, `novel_${chapters.length}ch_${Date.now()}.txt`);
        if (!silent) toastr.success(`已导出 ${chapters.length} 条`);
    }

    async function exportAsJSON(silent = false) {
        if (!(await verifyExportResults())) return;
        if (settings.generationMode === 'role-batch') {
            if (fileOperation) return;
            fileOperation = true;
            updateUI();
            try {
                const worldbook = await roleRunner.exportWorldbook();
                downloadFile(
                    JSON.stringify(worldbook, null, 2),
                    `role-worldbook_${Date.now()}.json`,
                    'application/json',
                );
                if (!silent) toastr.success('已导出角色世界书');
            } catch (error) {
                toastr.warning(error.message);
            } finally {
                fileOperation = false;
                updateUI();
            }
            return;
        }
        const chapters = getAllChapters();
        if (!chapters.length) {
            if (!silent) toastr.warning('没有内容');
            return;
        }
        downloadFile(
            JSON.stringify({ time: new Date().toISOString(), chapters }, null, 2),
            `novel_${Date.now()}.json`,
            'application/json',
        );
        if (!silent) toastr.success('已导出 JSON');
    }

    async function importWorldbookFile(file) {
        if (!file || settings.isRunning || fileOperation) return;
        fileOperation = true;
        updateUI();
        try {
            let data;
            try {
                data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
            } catch {
                throw new Error('世界书 JSON 格式无效，请检查文件');
            }
            const result = await roleRunner.importWorldbook(data, file.name);
            toastr.success(
                `已导入 ${result.added} 位角色，跳过 ${result.duplicates} 个重名项${result.skipped ? `、${result.skipped} 个无效条目` : ''}`,
            );
        } catch (error) {
            // Parser messages may contain source text; only retain this bounded user-facing error.
            if (error.message === '世界书 JSON 格式无效，请检查文件') recordError(error, { phase: 'import-worldbook' });
            toastr.warning(error.message);
        } finally {
            fileOperation = false;
            $('#nag-role-worldbook-file').val('');
            syncUI();
        }
    }

    async function importRoleImageFile(file) {
        if (!file || settings.isRunning || fileOperation) return;
        if (settings.roleImageLibrary?.items?.length) {
            $('#nag-role-image-file').val('');
            return toastr.info('请先清空当前作品图片库，再导入下一个作品');
        }
        fileOperation = true;
        updateUI();
        const summary = $('#nag-role-image-library-summary');
        try {
            summary.text('正在读取 ZIP 目录…');
            const result = await importRoleImageZip(file, host, {
                onProgress: ({ done, total }) => summary.text(`正在逐张导入图片 ${done}/${total}…`),
            });
            settings.roleImageLibrary = result.library;
            resetChecklistPicker();
            saveSettings();
            const listed = result.library.checklist;
            toastr.success(
                `已导入「${result.library.workName}」${result.imported} 张角色图片${result.skipped ? `，跳过 ${result.skipped} 项` : ''}；清单共 ${listed.roles.length} 个角色${listed.skins.length ? `、${listed.skins.length} 个皮肤` : ''}，可点「从清单添加到名单」`,
            );
        } catch (error) {
            toastr.warning(error.message);
        } finally {
            fileOperation = false;
            $('#nag-role-image-file').val('');
            updateUI();
        }
    }

    async function clearRoleImages() {
        if (settings.isRunning || fileOperation) return;
        if (!settings.roleImageLibrary?.items?.length) return toastr.info('图片库已经为空');
        fileOperation = true;
        updateUI();
        try {
            const result = await clearRoleImageLibrary(settings.roleImageLibrary, host);
            settings.roleImageLibrary = result.library;
            resetChecklistPicker();
            saveSettings();
            toastr.info(
                result.failed
                    ? `已删除 ${result.deleted} 张，${result.failed} 张未能删除并保留在图片库中`
                    : `已清空图片库，共删除 ${result.deleted} 张`,
            );
        } catch (error) {
            toastr.warning(error.message);
        } finally {
            fileOperation = false;
            updateUI();
        }
    }

    // ============================================
    // 从清单添加到角色名单
    // ============================================

    const checklistSelection = new Set();
    let checklistOpen = false;
    let checklistRenderKey = null;

    function resetChecklistPicker() {
        checklistSelection.clear();
        checklistRenderKey = null;
    }

    function checklistRowsHtml(rows) {
        return rows
            .map((row) => {
                const state = row.inRoster ? '已在名单' : row.hasImage ? '有图' : '无图';
                const cls = row.inRoster ? 'is-in-roster' : row.hasImage ? 'has-image' : 'no-image';
                const checked = !row.inRoster && checklistSelection.has(row.name) ? ' checked' : '';
                return `<label class="nag-role-checklist-row ${cls}"><input type="checkbox" class="nag-role-checklist-check" value="${escapeAttribute(row.name)}"${row.inRoster ? ' disabled' : ''}${checked}><span class="nag-role-checklist-name">${escapeHtml(row.name)}</span><span class="nag-role-checklist-tag">${state}</span></label>`;
            })
            .join('');
    }

    function updateChecklistCount() {
        const count = checklistSelection.size;
        $('#nag-btn-role-checklist-add')
            .text(`➕ 加入名单（${count}）`)
            .prop('disabled', !count || settings.isRunning || fileOperation);
    }

    /** Re-render only when the roster, library, search or open state changed (not on the 1 s refresh). */
    function renderChecklistPicker(force = false) {
        const library = settings.roleImageLibrary;
        const hasLibrary = !!library?.items?.length;
        const available = hasLibrary && hasChecklistRoles(library);
        $('#nag-btn-role-checklist-toggle')
            .toggle(available)
            .text(checklistOpen ? '📋 收起清单' : '📋 从清单添加到名单');
        $('#nag-role-checklist-legacy').toggle(hasLibrary && !available);
        const panel = $('#nag-role-checklist');
        panel.prop('hidden', !(available && checklistOpen));
        if (!available || !checklistOpen) return;
        const query = String($('#nag-role-checklist-search').val() || '');
        const key = [library.workName, library.items.length, query, settings.roleNames].join('\u0000');
        if (!force && key === checklistRenderKey) return updateChecklistCount();
        checklistRenderKey = key;
        const view = listChecklistRoles(library, settings.roleNames, query);
        const roster = new Set(parseRoleNames(settings.roleNames));
        for (const name of [...checklistSelection]) if (roster.has(name)) checklistSelection.delete(name);
        const all = [...view.roles, ...view.skins];
        const inRoster = library.checklist.roles.concat(library.checklist.skins).filter((name) => roster.has(name));
        $('#nag-role-checklist-summary').text(
            `「${library.workName}」清单 ${view.total} 个名字，已在名单 ${inRoster.length} 个${query.trim() ? `；搜索到 ${all.length} 个` : ''}`,
        );
        $('#nag-role-checklist-roles').html(
            view.roles.length
                ? checklistRowsHtml(view.roles)
                : `<small class="nag-hint">${query.trim() ? '没有搜索到角色' : '清单里没有角色'}</small>`,
        );
        $('#nag-role-checklist-skins-wrap').toggle(library.checklist.skins.length > 0);
        $('#nag-role-checklist-skins-count').text(
            query.trim() ? `${view.skins.length}/${library.checklist.skins.length}` : library.checklist.skins.length,
        );
        $('#nag-role-checklist-skins').html(
            view.skins.length ? checklistRowsHtml(view.skins) : '<small class="nag-hint">没有搜索到皮肤</small>',
        );
        updateChecklistCount();
    }

    /** Select or clear the visible, not-yet-added rows of one section. */
    function setChecklistSection(section, selected) {
        $(section)
            .find('.nag-role-checklist-check:not(:disabled)')
            .each(function () {
                this.checked = selected;
                if (selected) checklistSelection.add(this.value);
                else checklistSelection.delete(this.value);
            });
        updateChecklistCount();
    }

    function addChecklistSelection() {
        if (settings.isRunning || fileOperation) return toastr.warning('请先停止任务，再修改角色名单');
        if (settings.generationMode !== 'role-batch') return;
        const library = settings.roleImageLibrary;
        if (!hasChecklistRoles(library)) return;
        const order = [...library.checklist.roles, ...library.checklist.skins];
        const names = order.filter((name) => checklistSelection.has(name));
        if (!names.length) return toastr.info('请先勾选要加入的角色');
        const result = addNamesToRoster(settings.roleNames, names);
        settings.roleNames = result.text;
        $('#nag-set-prompt').val(settings.roleNames);
        roleRunner.saveInput();
        saveSettings();
        checklistSelection.clear();
        updateUI();
        toastr.success(
            `已加入 ${result.added.length} 个名字${result.skipped ? `，${result.skipped} 个已在名单中跳过` : ''}`,
        );
    }

    let previewName = null;
    function closeRoleImagePreview() {
        const preview = document.getElementById('nag-role-image-preview');
        if (!preview) return;
        preview.hidden = true;
        previewName = null;
        // Drop the decoded original so only thumbnails stay in memory.
        preview.querySelector('img')?.removeAttribute('src');
    }

    function syncRoleImagePreviewToggle() {
        const preview = document.getElementById('nag-role-image-preview');
        const toggle = preview?.querySelector('.nag-role-image-preview-toggle');
        if (!toggle || previewName == null) return;
        const disabled = isRoleImageDisabled(previewName, settings.roleImageLibrary);
        toggle.textContent = disabled ? '恢复使用这张图' : '这个角色不用图';
        toggle.disabled = settings.isRunning || fileOperation;
        preview.classList.toggle('is-disabled', disabled);
    }

    /** Full-screen viewer: the original image is only fetched here, on demand. */
    function showRoleImagePreview(index) {
        const name = (settings.roleBatch?.names || parseRoleNames(settings.roleNames))[index];
        const image = name ? matchRoleImage(name, settings.roleImageLibrary).item : null;
        const preview = document.getElementById('nag-role-image-preview');
        const imageElement = preview?.querySelector('img');
        if (!image || !preview || !imageElement) return;
        previewName = name;
        imageElement.src = image.path;
        imageElement.alt = name;
        const caption = preview.querySelector('.nag-role-image-preview-caption');
        if (caption) caption.textContent = image.name === name ? name : `${name} → ${image.name}`;
        syncRoleImagePreviewToggle();
        preview.hidden = false;
    }

    function roleImageSlot(name, index, imageLibrary) {
        if (!imageLibrary?.items?.length) return { sig: '', html: '' };
        const match = matchRoleImage(name, imageLibrary);
        if (!match.item) {
            const label = match.status === 'ambiguous' ? '?' : '';
            return {
                sig: `none|${match.reason}`,
                html: `<span class="nag-role-thumb is-empty${match.status === 'ambiguous' ? ' is-ambiguous' : ''}" title="无图：${escapeAttribute(match.reason)}" aria-label="无图：${escapeAttribute(match.reason)}">${label}</span>`,
            };
        }
        const disabled = isRoleImageDisabled(name, imageLibrary);
        const src = match.item.thumbPath || match.item.path;
        const title = `${disabled ? '已设为不用图。' : ''}点击查看原图：${match.item.name}`;
        return {
            sig: `img|${index}|${src}|${disabled}|${match.item.name}`,
            html: `<button type="button" class="nag-role-thumb${disabled ? ' is-disabled' : ''}" data-index="${index}" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(`${name}：${title}`)}"><img src="${escapeAttribute(src)}" alt="" loading="lazy" decoding="async" draggable="false"></button>`,
        };
    }

    /** Update rows in place so thumbnails are not rebuilt by the 1-second refresh while running. */
    function renderRoleRows(container, rows) {
        if (!container) return;
        const current = container.children;
        const sameRows =
            current.length === rows.length && rows.every((row, index) => current[index].dataset.rowKey === row.key);
        if (!sameRows) {
            container.innerHTML = rows
                .map(
                    (row) =>
                        `<div class="ttw-memory-item nag-role-status-row" data-row-key="${escapeAttribute(row.key)}"><span class="nag-role-status-name">${row.main}</span><span class="nag-role-row-controls">${row.controls}</span><span class="nag-role-image-slot" data-sig="${escapeAttribute(row.slot.sig)}">${row.slot.html}</span></div>`,
                )
                .join('');
            [...container.children].forEach((element, index) => {
                element.nagMain = rows[index].main;
                element.nagControls = rows[index].controls;
            });
            return;
        }
        rows.forEach((row, index) => {
            const element = current[index];
            const [main, controls, slot] = element.children;
            if (element.nagMain !== row.main) {
                main.innerHTML = row.main;
                element.nagMain = row.main;
            }
            if (element.nagControls !== row.controls) {
                controls.innerHTML = row.controls;
                element.nagControls = row.controls;
            }
            if (slot.dataset.sig !== row.slot.sig) {
                slot.innerHTML = row.slot.html;
                slot.dataset.sig = row.slot.sig;
            }
        });
    }

    // ============================================
    // 设置 & UI
    // ============================================

    function loadSettings() {
        settings = Object.assign({}, defaultSettings, host.readSettings(extensionName));
        const savedSettings = host.readSettings(extensionName);
        if (!Object.hasOwn(savedSettings, 'isolateRoleResult'))
            settings.isolateRoleResult = !!savedSettings.hideHistoryFromModel;
        delete settings.hideHistoryFromModel;
        void host
            .restoreLegacyVisibility()
            .catch((error) => recordError(error, { phase: 'restore-legacy-visibility' }));
        settings.panelCollapsed = Object.assign({}, defaultSettings.panelCollapsed, settings.panelCollapsed || {});
        settings.roleArchive = normalizeRoleArchive(settings.roleArchive);
        settings.isRunning = false;
        settings.isPaused = false;
        try {
            roleRunner.restore();
            saveSettings();
        } catch (error) {
            recordError(error, { phase: 'load-recovery' });
            toastr.warning(error.message);
        }
        resultIsolation?.refresh();
    }

    function saveSettings() {
        host.writeSettings(extensionName, settings);
    }

    let renderedArchiveKey = null;
    function renderRoleArchive(names) {
        const key = names.join('\n');
        if (key === renderedArchiveKey) return;
        renderedArchiveKey = key;
        $('#nag-archive-count').text(names.length ? `（${names.length}）` : '');
        const rows = names.map(
            (name, index) =>
                `<div class="nag-archive-row"><span class="nag-archive-name">${escapeHtml(name)}</span><button type="button" class="menu_button nag-archive-remove" data-index="${index}">删除</button></div>`,
        );
        $('#nag-archive-list').html(
            rows.length
                ? rows.join('')
                : '<small class="nag-hint">还没有收录任何角色。生成成功会自动收录，也可以在下面批量添加。</small>',
        );
    }

    function saveRoleArchive(next, message) {
        settings.roleArchive = normalizeRoleArchive(next);
        saveSettings();
        renderedArchiveKey = null;
        updateUI();
        if (message) toastr.info(message);
    }

    function updateUI() {
        resultIsolation?.refresh();
        roleSelection?.refresh();
        const batchMode = settings.generationMode === 'role-batch';
        const batch = settings.roleBatch;
        if (batchMode && batch && !settings.isRunning && !fileOperation) {
            const parsed = parseRoleNames(settings.roleNames);
            if (batch.names && JSON.stringify(batch.names) !== JSON.stringify(parsed)) {
                updateRoleNames(batch, parsed);
                batch.inputNames = settings.roleNames;
                batch.inputLimit = settings.totalChapters;
            }
        }
        const roleNames = batch?.names || parseRoleNames(settings.roleNames);
        const total = batchMode ? roleNames.length : settings.totalChapters;
        const completed = batchMode ? batch?.items?.filter(roleComplete).length || 0 : settings.currentChapter;
        const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : 0;
        $('#nag-progress-fill').css('width', `${pct}%`);
        $('#nag-progress-text').text(`${completed} / ${total} (${pct}%)`);
        const busy = settings.isRunning || fileOperation;
        $('#nag-set-mode, #nag-set-prompt, #nag-set-total').prop('disabled', busy);
        $('#nag-set-total').prop('readOnly', batchMode);
        if (batchMode) $('#nag-set-total').val(roleNames.length);
        $('#nag-role-name-hint, #nag-btn-import-worldbook').toggle(batchMode);
        const imageLibrary = settings.roleImageLibrary;
        const imageCount = Array.isArray(imageLibrary?.items) ? imageLibrary.items.length : 0;
        $('#nag-role-image-library-controls').toggle(batchMode);
        $('#nag-role-image-library-summary').text(
            imageCount ? `${imageLibrary.workName}：${imageCount} 张图片` : '尚未导入作品图片',
        );
        $('#nag-btn-role-image-import, #nag-btn-role-image-clear, #nag-role-image-file').prop('disabled', busy);
        if (batchMode) renderChecklistPicker();
        const archiveNames = normalizeRoleArchive(settings.roleArchive);
        const archiveNameSet = new Set(archiveNames);
        renderRoleArchive(archiveNames);
        const repeatedNames = batchMode ? duplicateRoleNames(settings.roleNames) : [];
        $('#nag-role-duplicate-hint')
            .toggle(repeatedNames.length > 0)
            .text(
                repeatedNames.length
                    ? `名单中有 ${repeatedNames.length} 个重复全名，保存后自动去重：${repeatedNames.slice(0, 5).join('、')}${repeatedNames.length > 5 ? '…' : ''}`
                    : '',
            );
        const currentBatch = batch?.identity === host.snapshot().identity ? batch : null;
        const chat = batchMode ? host.getChat() : null;
        const result = currentBatch?.resultFloor != null ? chat?.[currentBatch.resultFloor] : chat?.at(-1);
        const unknownPages =
            batchMode && result && !result.is_user && !result.is_system
                ? countUnidentifiedRolePages(currentBatch, result)
                : 0;
        $('#nag-role-unidentified-hint')
            .toggle(unknownPages > 0)
            .text(
                unknownPages
                    ? `有 ${unknownPages} 条备选回复缺少可核对的当前批次角色记录，无法自动判断是否同名；请先人工核对。`
                    : '',
            );
        $('#nag-role-correction-toggle')
            .toggle(batchMode && !!batch)
            .prop('disabled', busy);
        $('#nag-btn-restore-prompt')
            .toggle(batchMode && !!batch)
            .prop('disabled', busy);
        $('#nag-panel-archive').toggle(batchMode);
        $('#nag-role-correction-toggle').text(roleCorrection ? '完成纠错' : '手动纠错');
        $('#nag-role-correction-hint').toggle(batchMode && roleCorrection && !!batch);
        $('#nag-btn-import-worldbook, #nag-btn-export-json').prop('disabled', busy);
        $('#nag-btn-export-json').text(batchMode ? '📦 世界书 JSON' : '📦 JSON');
        $('#nag-btn-export-json').attr(
            'title',
            batchMode ? '合并导出已有与新增角色；楼层范围仅用于 TXT 导出' : '导出所选楼层的 JSON',
        );
        $('#nag-set-autosave, #nag-set-retries').prop('disabled', batchMode);
        $('#nag-set-minlen, #nag-set-isolate-result, #nag-set-reroll-confirm, #nag-set-buffer-stream').prop(
            'disabled',
            busy,
        );
        $('.nag-result-isolation-setting').toggle(batchMode);
        $('#nag-minlen-label').text(batchMode ? '最小字数（防截断）' : '最小章节长度');
        $('#nag-total-label').text(batchMode ? '角色总数（自动）' : '目标章节');
        $('#nag-prompt-label').text(batchMode ? '角色名单（每行一个）' : '提示词');
        $('#nag-role-results').toggle(batchMode);
        renderRoleRows(
            $('#nag-role-results')[0],
            batchMode
                ? roleNames.map((name, index) => {
                      const item = batch?.items[index] || {};
                      const suffix = item.processing ? ` 第 ${batch.attempt}/3 次尝试` : '';
                      const manual = item.manualStatus ? '（手动）' : '';
                      const archivedMark =
                          item.archived || (!roleComplete(item) && archiveNameSet.has(String(name).trim()))
                              ? '（名录）'
                              : '';
                      const controls =
                          roleCorrection && item.id && !busy
                              ? `<span class="nag-role-correction-actions"><button type="button" class="menu_button nag-role-status-set" data-index="${index}" data-status="complete">✓ 完成</button><button type="button" class="menu_button nag-role-status-set" data-index="${index}" data-status="failed">✗ 失败</button><button type="button" class="menu_button nag-role-status-set" data-index="${index}" data-status="auto">自动</button></span>`
                              : '';
                      return {
                          key: `${index}:${name}`,
                          main: `${roleStatusRenderer.getStatusIcon(item)} ${index + 1}. ${escapeHtml(name)}${suffix}${manual}${archivedMark}`,
                          controls,
                          slot: roleImageSlot(name, index, imageLibrary),
                      };
                  })
                : [],
        );
        syncRoleImagePreviewToggle();

        const [txt, cls] = settings.isRunning
            ? settings.isPaused
                ? ['⏸️ 已暂停', 'paused']
                : ['▶️ 运行中', 'running']
            : ['⏹️ 已停止', 'stopped'];
        $('#nag-status').text(txt).removeClass('stopped paused running').addClass(cls);

        $('#nag-btn-start').prop('disabled', busy);
        $('#nag-btn-pause').prop('disabled', !settings.isRunning || settings.isPaused);
        $('#nag-btn-resume').prop('disabled', !settings.isPaused);
        $('#nag-btn-stop').prop('disabled', !settings.isRunning);
        $('#nag-btn-reset').prop('disabled', busy);
        $('#nag-btn-start').text(batchMode ? '▶️ 开始／继续' : '▶️ 开始');
        $('#nag-btn-reset').text(batchMode ? '🔄 重置（保留已完成）' : '🔄 重置');
        $('#nag-btn-restart-role').toggle(batchMode).prop('disabled', busy);

        if (settings.isRunning && generationStats.startTime && generationStats.chaptersGenerated > 0) {
            const elapsed = Date.now() - generationStats.startTime;
            const avg = elapsed / generationStats.chaptersGenerated;
            $('#nag-time-elapsed').text(formatDuration(elapsed));
            $('#nag-time-remaining').text(formatDuration(avg * (total - completed)));
        }
        $('#nag-stat-errors').text(generationStats.errors.length);

        $('#nag-set-start-floor, #nag-set-end-floor').prop('disabled', settings.exportAll);
        $('#nag-floor-inputs').toggleClass('disabled', settings.exportAll);

        // 发送阶段弹窗设置
        $('#nag-send-toast-settings').toggleClass('disabled', !settings.enableSendToastDetection);
        $('#nag-set-send-toast-timeout, #nag-set-send-post-toast-wait').prop(
            'disabled',
            !settings.enableSendToastDetection,
        );

        // 回复阶段弹窗设置
        $('#nag-reply-toast-settings').toggleClass('disabled', !settings.enableReplyToastDetection);
        $('#nag-set-reply-toast-timeout, #nag-set-reply-post-toast-wait').prop(
            'disabled',
            !settings.enableReplyToastDetection,
        );
    }

    function toggleTagSettings() {
        $('#nag-tags-container, #nag-separator-container').toggle(settings.extractMode === 'tags');
    }

    function togglePanel(panelId) {
        const panel = $(`#nag-panel-${panelId}`);
        const isCollapsed = panel.hasClass('collapsed');

        if (isCollapsed) {
            panel.removeClass('collapsed');
            settings.panelCollapsed[panelId] = false;
        } else {
            panel.addClass('collapsed');
            settings.panelCollapsed[panelId] = true;
        }

        saveSettings();
    }

    function createUI() {
        const html = `
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 小说自动生成器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <div class="nag-section nag-status-panel">
                    <span id="nag-status" class="nag-status-badge stopped">⏹️ 已停止</span>
                    <div class="nag-progress-container">
                        <div class="nag-progress-bar"><div id="nag-progress-fill" class="nag-progress-fill"></div></div>
                        <div id="nag-progress-text">0 / 1000 (0%)</div>
                    </div>
                    <div class="nag-stats-row">
                        <span>⏱️ <span id="nag-time-elapsed">--:--:--</span></span>
                        <span>⏳ <span id="nag-time-remaining">--:--:--</span></span>
                        <span>❌ <span id="nag-stat-errors">0</span></span>
                    </div>
                </div>
                
                <div class="nag-section nag-controls">
                    <div class="nag-btn-row">
                        <button id="nag-btn-start" class="menu_button">▶️ 开始</button>
                        <button id="nag-btn-pause" class="menu_button" disabled>⏸️ 暂停</button>
                        <button id="nag-btn-resume" class="menu_button" disabled>⏯️ 恢复</button>
                        <button id="nag-btn-stop" class="menu_button" disabled>⏹️ 停止</button>
                    </div>
                    <div class="nag-btn-row"><button id="nag-btn-reset" class="menu_button">🔄 重置</button><button id="nag-btn-restart-role" class="menu_button" style="display:none">从头生成</button></div>
                    <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-buffer-stream"><span>任务流式回复由服务端暂存</span></label></div>
                    <small class="nag-hint">需要安装服务器缓冲组件。页面恢复后继续接收；服务或模型断开仍可能中断。</small>
                    <div class="nag-btn-row"><button id="nag-btn-error-log" class="menu_button">下载错误日志</button><button id="nag-btn-clear-errors" class="menu_button">清空错误日志</button></div>
                </div>

                <!-- 📝 生成设置模块 -->
                <div id="nag-panel-generate" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="generate">
                        <span class="nag-panel-title">📝 生成设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="generate" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-setting-item"><label>生成方式</label><select id="nag-set-mode"><option value="novel">原有自动续写</option><option value="role-batch">同楼层批量生成</option></select></div>
                        <div class="nag-setting-item"><label id="nag-total-label">目标章节</label><input type="number" id="nag-set-total" min="1"></div>
                        <div class="nag-setting-item"><label id="nag-prompt-label">提示词</label><textarea id="nag-set-prompt" rows="4"></textarea></div>
                        <small id="nag-role-name-hint" class="nag-hint" style="display:none">每行一个完整角色名。同名只处理一次，已有成功结果自动跳过。修改写卡提示词：先停止任务，在聊天中编辑并保存原提示词楼层，保留 [[角色名]]；继续或重生成时自动使用新提示词。</small>
                        <div id="nag-role-image-library-controls" class="nag-role-image-library-controls" style="display:none">
                            <div class="nag-btn-row">
                                <button type="button" id="nag-btn-role-image-import" class="menu_button">📥 导入作品 ZIP</button>
                                <button type="button" id="nag-btn-role-image-clear" class="menu_button">🗑️ 清空图片库</button>
                                <input id="nag-role-image-file" type="file" accept=".zip,application/zip" hidden>
                            </div>
                            <small id="nag-role-image-library-summary" class="nag-hint">尚未导入作品图片</small>
                            <div class="nag-btn-row">
                                <button type="button" id="nag-btn-role-checklist-toggle" class="menu_button" style="display:none">📋 从清单添加到名单</button>
                            </div>
                            <small id="nag-role-checklist-legacy" class="nag-hint" style="display:none">这个图片库是旧版本导入的，没有保存清单里的角色名。清空图片库后重新导入同一个 ZIP，即可从清单把角色加入名单。</small>
                            <div id="nag-role-checklist" class="nag-role-checklist" hidden>
                                <input type="search" id="nag-role-checklist-search" class="text_pole" placeholder="搜索角色名" autocomplete="off" enterkeyhint="search">
                                <small id="nag-role-checklist-summary" class="nag-hint"></small>
                                <div class="nag-btn-row nag-role-checklist-actions">
                                    <button type="button" class="menu_button nag-role-checklist-all" data-target="#nag-role-checklist-roles">全选</button>
                                    <button type="button" class="menu_button nag-role-checklist-none" data-target="#nag-role-checklist-roles">全不选</button>
                                    <button type="button" id="nag-btn-role-checklist-add" class="menu_button" disabled>➕ 加入名单（0）</button>
                                </div>
                                <div id="nag-role-checklist-roles" class="nag-role-checklist-list"></div>
                                <details id="nag-role-checklist-skins-wrap" class="nag-role-checklist-skins" style="display:none">
                                    <summary>皮肤（<span id="nag-role-checklist-skins-count">0</span>）</summary>
                                    <div class="nag-btn-row nag-role-checklist-actions">
                                        <button type="button" class="menu_button nag-role-checklist-all" data-target="#nag-role-checklist-skins">全选皮肤</button>
                                        <button type="button" class="menu_button nag-role-checklist-none" data-target="#nag-role-checklist-skins">全不选皮肤</button>
                                    </div>
                                    <div id="nag-role-checklist-skins" class="nag-role-checklist-list"></div>
                                </details>
                                <small class="nag-hint">名字和清单完全一致，加入后与图片同名；已在名单里的灰色不可选。全选只选当前搜索结果。</small>
                            </div>
                            <small class="nag-hint">名单里角色名右边有缩略图＝有图，点缩略图看原图；空框＝无图，照常按文字生成。匹配顺序：先完整名称，再去掉作品名后按「角色名+备注」（如 安比（绝区零）改 → 安比（改））；写了备注但没有对应形态图时不使用本体图，不做模糊匹配。</small>
                        </div>
                        <small id="nag-role-duplicate-hint" class="nag-hint" style="display:none"></small>
                        <small id="nag-role-unidentified-hint" class="nag-hint" style="display:none"></small>
                        <div class="nag-checkbox-group nag-result-isolation-setting">
                            <label class="nag-checkbox-label" title="当前页及前后各一页正常预览，旧角色卡不进入下一次请求；预设、命令和上方消息照常使用"><input type="checkbox" id="nag-set-isolate-result"><span>隔离写卡结果（三页预览豁免）</span></label><small id="nag-result-preview-window" class="nag-hint" hidden></small>
                            <label class="nag-checkbox-label" title="开启：重生成此角色时新内容先作为候选版本放在末尾，确认“用这版替换”后才替换原页，可“再生成一版”比较或“放弃”。关闭：生成完成并校验通过后自动替换"><input type="checkbox" id="nag-set-reroll-confirm"><span>重生成后手动确认</span></label>
                        </div>
                        <div class="nag-btn-row">
                            <button type="button" id="nag-role-correction-toggle" class="menu_button" style="display:none">手动纠错</button>
                            <button type="button" id="nag-btn-restore-prompt" class="menu_button" style="display:none">恢复原始提示词</button>
                        </div>
                        <small id="nag-role-correction-hint" class="nag-hint" style="display:none">只修改名单状态，不删除回复。标记失败后可继续生成；标记完成不会创建正文，没有正文时无法导出该角色。</small>
                        <div id="nag-role-results" class="ttw-memory-queue" style="display:none"></div>
                    </div>
                </div>

                <!-- 🗂️ 已完成角色名录模块 -->
                <div id="nag-panel-archive" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="archive">
                        <span class="nag-panel-title">🗂️ 已完成角色名录<span id="nag-archive-count"></span></span>
                        <div class="nag-panel-actions">
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <small class="nag-hint">生成成功会自动收录名字；生成名单里出现名录中的名字时自动跳过并标记“（名录）”，不会重复生成。想重新生成某个角色，先在这里删除它的名字。名录在所有聊天中共用，不写入角色卡或世界书。</small>
                        <div id="nag-archive-list" class="nag-archive-list"></div>
                        <div class="nag-btn-row">
                            <button type="button" id="nag-btn-archive-collect" class="menu_button">收录当前已完成</button>
                            <button type="button" id="nag-btn-archive-clear" class="menu_button">清空名录</button>
                        </div>
                        <div class="nag-setting-item"><label>批量添加</label><textarea id="nag-archive-input" rows="2" placeholder="每行一个完整角色名"></textarea></div>
                        <button type="button" id="nag-btn-archive-add" class="menu_button">添加</button>
                    </div>
                </div>

                <!-- 📤 导出设置模块 -->
                <div id="nag-panel-export" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="export">
                        <span class="nag-panel-title">📤 导出设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="export" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-floor-info">共 <span id="nag-total-floors">${getTotalFloors()}</span> 条 <button id="nag-btn-refresh-floors" class="menu_button_icon">🔄</button></div>
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-export-all"><span>📑 导出全部</span></label></div>
                        <div id="nag-floor-inputs" class="nag-setting-row">
                            <div class="nag-setting-item"><label>起始楼层</label><input type="number" id="nag-set-start-floor" min="0"></div>
                            <div class="nag-setting-item"><label>结束楼层</label><input type="number" id="nag-set-end-floor" min="0"></div>
                        </div>
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-include-user"><span>👤 用户消息</span></label>
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-include-ai"><span>🤖 AI 回复</span></label>
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-use-raw"><span>📄 原始 (chat.mes)</span></label>
                        </div>
                        <div class="nag-btn-row">
                            <button id="nag-btn-import-worldbook" class="menu_button" style="display:none">📥 导入世界书</button>
                            <input id="nag-role-worldbook-file" type="file" accept=".json,application/json" hidden>
                            <button id="nag-btn-export-txt" class="menu_button">📄 TXT</button>
                            <button id="nag-btn-export-json" class="menu_button">📦 JSON</button>
                        </div>
                    </div>
                </div>

                <!-- 🏷️ 标签提取模块 -->
                <div id="nag-panel-extract" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="extract">
                        <span class="nag-panel-title">🏷️ 标签提取</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="extract" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-setting-item">
                            <label>提取模式</label>
                            <select id="nag-set-extract-mode">
                                <option value="all">全部内容</option>
                                <option value="tags">只提取指定标签</option>
                            </select>
                        </div>
                        <div class="nag-setting-item" id="nag-tags-container">
                            <label>标签名称 <span class="nag-hint">(空格/逗号分隔)</span></label>
                            <textarea id="nag-set-tags" rows="1" placeholder="content detail 正文"></textarea>
                        </div>
                        <div class="nag-setting-item" id="nag-separator-container">
                            <label>分隔符</label>
                            <select id="nag-set-separator">
                                <option value="\\n\\n">空行</option>
                                <option value="\\n">换行</option>
                                <option value="">无</option>
                            </select>
                        </div>
                        <div class="nag-setting-item">
                            <label>移除标签 <span class="nag-hint">(可选，空格/逗号分隔)</span></label>
                            <textarea id="nag-set-exclude-tags" rows="1" placeholder="thinking summary note"></textarea>
                        </div>
                        <div class="nag-extract-preview">
                            <div class="nag-preview-header">
                                <span>📋 预览</span>
                                <button id="nag-btn-refresh-preview" class="menu_button_icon">🔄</button>
                            </div>
                            <div id="nag-preview-content" class="nag-preview-box"><i>点击刷新</i></div>
                        </div>
                    </div>
                </div>

                <!-- ⚙️ 高级设置模块 -->
                <div id="nag-panel-advanced" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="advanced">
                        <span class="nag-panel-title">⚙️ 高级设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="advanced" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        
                        <!-- 发送阶段模块 -->
                        <div class="nag-module nag-module-send">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">📤</span>
                                <span class="nag-module-title">发送阶段</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">消息发送后，等待剧情推进等插件处理完成</div>
                                <div class="nag-checkbox-group">
                                    <label class="nag-checkbox-label">
                                        <input type="checkbox" id="nag-set-send-toast-detection">
                                        <span>💬 启用弹窗检测</span>
                                    </label>
                                </div>
                                <div id="nag-send-toast-settings">
                                    <div class="nag-setting-row">
                                        <div class="nag-setting-item">
                                            <label>等待超时 (ms)</label>
                                            <input type="number" id="nag-set-send-toast-timeout" min="5000" step="5000">
                                        </div>
                                        <div class="nag-setting-item">
                                            <label>额外等待 (ms)</label>
                                            <input type="number" id="nag-set-send-post-toast-wait" min="0" step="500">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 回复阶段模块 -->
                        <div class="nag-module nag-module-reply">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">📥</span>
                                <span class="nag-module-title">回复阶段</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">AI回复完成后，等待总结等插件处理完成</div>
                                <div class="nag-setting-row">
                                    <div class="nag-setting-item">
                                        <label>回复后等待 (ms)</label>
                                        <input type="number" id="nag-set-reply-wait" min="0" step="1000">
                                    </div>
                                    <div class="nag-setting-item">
                                        <label>稳定检查间隔 (ms)</label>
                                        <input type="number" id="nag-set-stability-interval" min="500" step="500">
                                    </div>
                                </div>
                                <div class="nag-setting-item">
                                    <label>稳定次数</label>
                                    <input type="number" id="nag-set-stability-count" min="1" style="width: 100px;">
                                </div>
                                <div class="nag-checkbox-group">
                                    <label class="nag-checkbox-label">
                                        <input type="checkbox" id="nag-set-reply-toast-detection">
                                        <span>💬 启用弹窗检测</span>
                                    </label>
                                </div>
                                <div id="nag-reply-toast-settings">
                                    <div class="nag-setting-row">
                                        <div class="nag-setting-item">
                                            <label>等待超时 (ms)</label>
                                            <input type="number" id="nag-set-reply-toast-timeout" min="10000" step="10000">
                                        </div>
                                        <div class="nag-setting-item">
                                            <label>额外等待 (ms)</label>
                                            <input type="number" id="nag-set-reply-post-toast-wait" min="0" step="500">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 生成控制模块 -->
                        <div class="nag-module nag-module-control">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">🔧</span>
                                <span class="nag-module-title">生成控制</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">控制自动生成的行为参数</div>
                                <div class="nag-setting-row">
                                    <div class="nag-setting-item">
                                        <label>自动保存间隔</label>
                                        <input type="number" id="nag-set-autosave" min="1">
                                    </div>
                                    <div class="nag-setting-item">
                                        <label>最大重试</label>
                                        <input type="number" id="nag-set-retries" min="1">
                                    </div>
                                </div>
                                <div class="nag-setting-item">
                                    <label>最小章节长度</label>
                                    <input type="number" id="nag-set-minlen" min="0" style="width: 100px;">
                                </div>
                            </div>
                        </div>
                        
                        <div class="nag-debug-hint">控制台调试: <code>nagDebug()</code></div>
                    </div>
                </div>

                <!-- 📚 TXT转世界书模块 -->
                <div class="nag-section">
                    <div class="nag-btn-row">
                        <button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400);">
                            📚 TXT转世界书
                        </button>
                    </div>
                </div>

            </div>
        </div>
        <div id="nag-role-image-preview" class="nag-role-image-preview-layer" hidden>
            <div class="nag-role-image-preview-dialog" role="dialog" aria-modal="true" aria-label="角色原图">
                <button type="button" class="nag-role-image-preview-close" aria-label="关闭">✕</button>
                <img alt="" decoding="async">
                <div class="nag-role-image-preview-bar">
                    <span class="nag-role-image-preview-caption"></span>
                    <button type="button" class="menu_button nag-role-image-preview-toggle"></button>
                </div>
            </div>
        </div>
    </div>`;

        $('#extensions_settings').append(html);
        // Full-screen viewer lives on <body> so panel transforms/overflow cannot confine it.
        $('#nag-role-image-preview').appendTo(document.body);
        bindEvents();
        syncUI();
        applyPanelStates();
    }

    function applyPanelStates() {
        Object.entries(settings.panelCollapsed).forEach(([panelId, isCollapsed]) => {
            if (isCollapsed) {
                $(`#nag-panel-${panelId}`).addClass('collapsed');
            }
        });
    }

    function bindEvents() {
        $('#nag-role-correction-toggle').on('click', () => {
            roleCorrection = !roleCorrection;
            updateUI();
        });
        $('#nag-role-results').on('click', '.nag-role-status-set', async function () {
            if (settings.isRunning || fileOperation) return;
            const index = Number(this.dataset.index),
                status = this.dataset.status;
            fileOperation = true;
            updateUI();
            try {
                await roleRunner.setRoleStatus(index, status);
                toastr.success(
                    status === 'failed'
                        ? '已标为失败，继续任务时会重新生成'
                        : status === 'complete'
                          ? '已手动标为完成'
                          : '已恢复自动判断',
                );
            } catch (error) {
                recordError(error, { phase: 'correct-role-status' });
                toastr.warning(error.message);
            } finally {
                fileOperation = false;
                updateUI();
            }
        });
        $('#nag-set-reroll-confirm').on('change', function () {
            settings.rerollConfirm = Boolean(this.checked);
            saveSettings();
            if (!settings.rerollConfirm && roleRunner.previewPending())
                toastr.info('已关闭手动确认；当前待确认的候选版本仍需“用这版替换”或“放弃”');
        });
        $('#nag-set-buffer-stream').on('change', function () {
            settings.bufferModelStream = Boolean(this.checked);
            saveSettings();
        });
        $('#nag-btn-start').on('click', startGeneration);
        $('#nag-btn-pause').on('click', pauseGeneration);
        $('#nag-btn-resume').on('click', resumeGeneration);
        $('#nag-btn-stop').on('click', stopGeneration);
        $('#nag-btn-reset').on('click', resetProgress);
        $('#nag-btn-restart-role').on('click', async () => {
            if (settings.isRunning) return;
            try {
                if (await host.confirmRoleRestart()) await resetProgress({ restart: true });
            } catch (error) {
                recordError(error, { phase: 'restart-task' });
                toastr.warning(error.message);
            }
        });
        $('#nag-btn-error-log').on('click', () => {
            const errors = settings.errorLog || [];
            if (!errors.length) return toastr.info('暂无错误日志');
            downloadFile(
                JSON.stringify({ pluginVersion, errors }, null, 2),
                `generation-errors-${Date.now()}.json`,
                'application/json',
            );
        });
        $('#nag-btn-clear-errors').on('click', () => {
            settings.errorLog = [];
            saveSettings();
            toastr.info('错误日志已清空');
        });
        $('#nag-btn-restore-prompt').on('click', async () => {
            if (settings.isRunning || fileOperation) return;
            const batch = settings.roleBatch;
            if (!batch || batch.identity !== host.snapshot().identity)
                return toastr.warning('请回到原批次聊天后再恢复提示词');
            if (!String(batch.template || '').includes('[[角色名]]'))
                return toastr.warning('批次记录里没有可用的提示词模板，请手动编辑聊天中的提示词并保留 [[角色名]]');
            const popup = host.getContext()?.Popup?.show;
            if (
                typeof popup?.confirm === 'function' &&
                !(await popup.confirm(
                    '恢复原始提示词',
                    '将把聊天中该用户楼层改回批次保存的原始模板（含 [[角色名]]），当前编辑内容会被覆盖。确定恢复？',
                ))
            )
                return;
            try {
                await host.restoreRoleTemplate(batch, { force: true });
                toastr.success('已恢复原始提示词模板，可以继续生成或重生成该角色');
            } catch (error) {
                recordError(error, { phase: 'restore-template' });
                toastr.warning(error.message);
            }
            updateUI();
        });
        $('#nag-btn-archive-add').on('click', () => {
            const names = parseRoleNames(String($('#nag-archive-input').val() || ''));
            if (!names.length) return toastr.info('请先输入角色名，每行一个');
            const before = normalizeRoleArchive(settings.roleArchive).length;
            const merged = mergeRoleArchive(settings.roleArchive, names);
            $('#nag-archive-input').val('');
            if (merged.length === before) return toastr.info('这些名字都已在名录中');
            saveRoleArchive(merged, `已收录 ${merged.length - before} 个名字`);
        });
        $('#nag-btn-archive-collect').on('click', () => {
            const batch = settings.roleBatch;
            if (!batch) return toastr.info('当前没有批量任务记录');
            const names = [...(batch.items || []), ...(batch.history || [])]
                .filter((item) => roleComplete(item) && item.name)
                .map((item) => item.name);
            if (!names.length) return toastr.info('当前没有已完成的角色可收录');
            const before = normalizeRoleArchive(settings.roleArchive).length;
            const merged = mergeRoleArchive(settings.roleArchive, names);
            if (merged.length === before) return toastr.info('已完成角色都已在名录中');
            saveRoleArchive(merged, `已收录 ${merged.length - before} 个已完成角色`);
        });
        $('#nag-archive-list').on('click', '.nag-archive-remove', function () {
            const name = normalizeRoleArchive(settings.roleArchive)[Number($(this).attr('data-index'))];
            if (!name) return;
            saveRoleArchive(
                removeRoleArchiveName(settings.roleArchive, name),
                `已从名录删除「${name}」，下次开始时会重新生成`,
            );
        });
        $('#nag-btn-archive-clear').on('click', async () => {
            if (!normalizeRoleArchive(settings.roleArchive).length) return toastr.info('名录已经为空');
            const popup = host.getContext()?.Popup?.show;
            if (
                typeof popup?.confirm === 'function' &&
                !(await popup.confirm(
                    '清空已完成角色名录',
                    '只会删除名录中的名字，不会删除任何角色卡或回复。确定清空？',
                ))
            )
                return;
            saveRoleArchive([], '已完成角色名录已清空');
        });
        $('#nag-btn-export-txt').on('click', () => exportNovel(false));
        $('#nag-btn-export-json').on('click', () => exportAsJSON(false));
        $('#nag-btn-import-worldbook').on('click', () => {
            if (!settings.isRunning && !fileOperation) $('#nag-role-worldbook-file').trigger('click');
        });
        $('#nag-role-worldbook-file').on('change', function () {
            void importWorldbookFile(this.files?.[0]);
        });
        $('#nag-btn-role-image-import').on('click', () => {
            if (!settings.isRunning && !fileOperation) $('#nag-role-image-file').trigger('click');
        });
        $('#nag-role-image-file').on('change', function () {
            void importRoleImageFile(this.files?.[0]);
        });
        $('#nag-btn-role-image-clear').on('click', clearRoleImages);
        $('#nag-btn-role-checklist-toggle').on('click', () => {
            checklistOpen = !checklistOpen;
            renderChecklistPicker(true);
        });
        $('#nag-role-checklist-search').on('input', () => renderChecklistPicker());
        $('#nag-role-checklist').on('change', '.nag-role-checklist-check', function () {
            if (this.checked) checklistSelection.add(this.value);
            else checklistSelection.delete(this.value);
            updateChecklistCount();
        });
        $('#nag-role-checklist').on('click', '.nag-role-checklist-all, .nag-role-checklist-none', function () {
            setChecklistSection(this.dataset.target, this.classList.contains('nag-role-checklist-all'));
        });
        $('#nag-btn-role-checklist-add').on('click', addChecklistSelection);
        $('#nag-role-image-preview').on('click', '.nag-role-image-preview-toggle', function () {
            if (settings.isRunning || fileOperation || previewName == null) return;
            const disabled = !isRoleImageDisabled(previewName, settings.roleImageLibrary);
            settings.roleImageLibrary = setRoleImageDisabled(previewName, disabled, settings.roleImageLibrary);
            saveSettings();
            updateUI();
        });
        $('#nag-role-results').on('click', '.nag-role-thumb[data-index]', function () {
            showRoleImagePreview(Number(this.dataset.index));
        });
        $('#nag-role-image-preview').on('click', function (event) {
            if (event.target === this || event.target.closest('.nag-role-image-preview-close')) closeRoleImagePreview();
        });
        $(document).on('keydown.nagRoleImagePreview', (event) => {
            if (event.key === 'Escape') closeRoleImagePreview();
        });
        $('#nag-btn-refresh-floors').on('click', () => $('#nag-total-floors').text(getTotalFloors()));
        $('#nag-btn-refresh-preview').on('click', refreshPreview);
        // TXT转世界书入口
        $('#nag-btn-txt-to-worldbook').on('click', () => {
            if (typeof window.TxtToWorldbook !== 'undefined') {
                window.TxtToWorldbook.open();
            } else {
                toastr.error('TXT转世界书模块未加载');
            }
        });

        // 面板折叠 - 排除帮助按钮
        $('.nag-panel-header').on('click', function (e) {
            // 如果点击的是帮助按钮区域，不处理折叠
            if ($(e.target).closest('.nag-help-btn').length > 0) {
                return;
            }
            const panelId = $(this).data('panel');
            togglePanel(panelId);
        });

        // 帮助按钮 - 使用原生事件绑定
        document.querySelectorAll('.nag-help-btn').forEach((btn) => {
            const topic = btn.getAttribute('data-help');

            // 阻止事件冒泡（不使用 preventDefault，否则会阻止 click）
            btn.addEventListener(
                'mousedown',
                (e) => {
                    e.stopPropagation();
                },
                false,
            );

            btn.addEventListener(
                'touchstart',
                (e) => {
                    e.stopPropagation();
                },
                { passive: true },
            ); // passive: true 表示不会调用 preventDefault

            btn.addEventListener(
                'touchend',
                (e) => {
                    e.stopPropagation();
                },
                { passive: true },
            );

            // 点击打开帮助
            btn.addEventListener(
                'click',
                (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    showHelp(topic);
                },
                false,
            );
        });

        // 导出设置
        $('#nag-set-export-all').on('change', function () {
            settings.exportAll = $(this).prop('checked');
            updateUI();
            saveSettings();
        });
        $('#nag-set-start-floor').on('change', function () {
            settings.exportStartFloor = +$(this).val() || 0;
            saveSettings();
        });
        $('#nag-set-end-floor').on('change', function () {
            settings.exportEndFloor = +$(this).val() || 99999;
            saveSettings();
        });
        $('#nag-set-include-user').on('change', function () {
            settings.exportIncludeUser = $(this).prop('checked');
            saveSettings();
        });
        $('#nag-set-include-ai').on('change', function () {
            settings.exportIncludeAI = $(this).prop('checked');
            saveSettings();
        });
        $('#nag-set-use-raw').on('change', function () {
            settings.useRawContent = $(this).prop('checked');
            saveSettings();
            refreshPreview();
        });

        // 标签提取
        $('#nag-set-extract-mode').on('change', function () {
            settings.extractMode = $(this).val();
            toggleTagSettings();
            saveSettings();
            refreshPreview();
        });
        $('#nag-set-tags').on('change', function () {
            settings.extractTags = $(this).val();
            saveSettings();
            refreshPreview();
        });
        $('#nag-set-exclude-tags').on('change', function () {
            settings.excludeTags = $(this).val();
            saveSettings();
            refreshPreview();
        });
        $('#nag-set-separator').on('change', function () {
            settings.tagSeparator = $(this).val().replace(/\\n/g, '\n');
            saveSettings();
            refreshPreview();
        });

        // 发送阶段弹窗检测
        $('#nag-set-send-toast-detection').on('change', function () {
            settings.enableSendToastDetection = $(this).prop('checked');
            updateUI();
            saveSettings();
        });
        $('#nag-set-send-toast-timeout').on('change', function () {
            settings.sendToastWaitTimeout = +$(this).val() || 60000;
            saveSettings();
        });
        $('#nag-set-send-post-toast-wait').on('change', function () {
            settings.sendPostToastWaitTime = +$(this).val() || 1000;
            saveSettings();
        });

        // 回复阶段设置
        $('#nag-set-reply-wait').on('change', function () {
            settings.replyWaitTime = +$(this).val() || 5000;
            saveSettings();
        });
        $('#nag-set-stability-interval').on('change', function () {
            settings.stabilityCheckInterval = +$(this).val() || 1000;
            saveSettings();
        });
        $('#nag-set-stability-count').on('change', function () {
            settings.stabilityRequiredCount = +$(this).val() || 3;
            saveSettings();
        });
        $('#nag-set-reply-toast-detection').on('change', function () {
            settings.enableReplyToastDetection = $(this).prop('checked');
            updateUI();
            saveSettings();
        });
        $('#nag-set-reply-toast-timeout').on('change', function () {
            settings.replyToastWaitTimeout = +$(this).val() || 300000;
            saveSettings();
        });
        $('#nag-set-reply-post-toast-wait').on('change', function () {
            settings.replyPostToastWaitTime = +$(this).val() || 2000;
            saveSettings();
        });

        // 生成控制
        $('#nag-set-mode').on('change', function () {
            if (settings.isRunning) return;
            settings.generationMode = $(this).val() === 'role-batch' ? 'role-batch' : 'novel';
            if (settings.generationMode === 'role-batch') roleRunner.saveInput();
            if (settings.generationMode === 'role-batch' && settings.roleBatch?.inputLimit) {
                settings.totalChapters = settings.roleBatch.inputLimit;
                $('#nag-set-total').val(settings.totalChapters);
            }
            $('#nag-set-prompt').val(settings.generationMode === 'role-batch' ? settings.roleNames : settings.prompt);
            saveSettings();
            updateUI();
        });
        $('#nag-set-total').on('input change', function () {
            settings.totalChapters = +$(this).val() || 1000;
            if (settings.generationMode === 'role-batch') roleRunner.saveInput();
            saveSettings();
            updateUI();
        });
        $('#nag-set-prompt').on('input change', function () {
            if (settings.generationMode === 'role-batch') settings.roleNames = $(this).val();
            else settings.prompt = $(this).val();
            if (settings.generationMode === 'role-batch') roleRunner.saveInput();
            saveSettings();
            updateUI();
        });
        $('#nag-set-prompt').on('change', function () {
            if (settings.generationMode !== 'role-batch') return;
            const duplicates = duplicateRoleNames(settings.roleNames);
            settings.roleNames = parseRoleNames(settings.roleNames).join('\n');
            $(this).val(settings.roleNames);
            roleRunner.saveInput();
            if (duplicates.length) toastr.info(`已去除 ${duplicates.length} 个重复全名；不同作品或版本不会合并`);
        });
        $('#nag-set-autosave').on('change', function () {
            settings.autoSaveInterval = +$(this).val() || 50;
            saveSettings();
        });
        $('#nag-set-retries').on('change', function () {
            settings.maxRetries = +$(this).val() || 3;
            saveSettings();
        });
        $('#nag-set-minlen').on('change', function () {
            settings.minChapterLength = +$(this).val() || 100;
            saveSettings();
        });
        $('#nag-set-isolate-result').on('change', async function () {
            const wanted = $(this).prop('checked');
            const previous = settings.isolateRoleResult;
            if (settings.isRunning || host.snapshot().generating) {
                $(this).prop('checked', previous);
                return toastr.warning('请等待当前生成停止后切换结果隔离');
            }
            $(this).add('#nag-btn-start, #nag-btn-reset, #nag-btn-restart-role').prop('disabled', true);
            try {
                if (!wanted) await resultIsolation.resetProtection();
                settings.isolateRoleResult = wanted;
                resultIsolation.refresh();
                if (wanted) await resultIsolation.prepare();
                saveSettings();
            } catch (error) {
                settings.isolateRoleResult = previous;
                resultIsolation.refresh();
                recordError(error, { phase: 'result-isolation' });
                toastr.warning(error.message);
            } finally {
                $(this).prop('checked', settings.isolateRoleResult);
                updateUI();
            }
        });
    }

    function syncUI() {
        // 生成设置
        $('#nag-set-total').val(settings.totalChapters);
        $('#nag-set-mode').val(settings.generationMode);
        $('#nag-set-prompt').val(settings.generationMode === 'role-batch' ? settings.roleNames : settings.prompt);

        // 导出设置
        $('#nag-set-export-all').prop('checked', settings.exportAll);
        $('#nag-set-start-floor').val(settings.exportStartFloor);
        $('#nag-set-end-floor').val(settings.exportEndFloor);
        $('#nag-set-include-user').prop('checked', settings.exportIncludeUser);
        $('#nag-set-include-ai').prop('checked', settings.exportIncludeAI);
        $('#nag-set-use-raw').prop('checked', settings.useRawContent);

        // 标签提取
        $('#nag-set-extract-mode').val(settings.extractMode);
        $('#nag-set-tags').val(settings.extractTags);
        $('#nag-set-exclude-tags').val(settings.excludeTags);
        $('#nag-set-separator').val(settings.tagSeparator.replace(/\n/g, '\\n'));

        // 发送阶段弹窗检测
        $('#nag-set-send-toast-detection').prop('checked', settings.enableSendToastDetection);
        $('#nag-set-send-toast-timeout').val(settings.sendToastWaitTimeout);
        $('#nag-set-send-post-toast-wait').val(settings.sendPostToastWaitTime);

        // 回复阶段设置
        $('#nag-set-reply-wait').val(settings.replyWaitTime);
        $('#nag-set-stability-interval').val(settings.stabilityCheckInterval);
        $('#nag-set-stability-count').val(settings.stabilityRequiredCount);
        $('#nag-set-reply-toast-detection').prop('checked', settings.enableReplyToastDetection);
        $('#nag-set-reply-toast-timeout').val(settings.replyToastWaitTimeout);
        $('#nag-set-reply-post-toast-wait').val(settings.replyPostToastWaitTime);

        // 生成控制
        $('#nag-set-autosave').val(settings.autoSaveInterval);
        $('#nag-set-retries').val(settings.maxRetries);
        $('#nag-set-minlen').val(settings.minChapterLength);
        $('#nag-set-isolate-result').prop('checked', Boolean(settings.isolateRoleResult));
        $('#nag-set-reroll-confirm').prop('checked', settings.rerollConfirm !== false);
        $('#nag-set-buffer-stream').prop('checked', Boolean(settings.bufferModelStream));
        resultIsolation?.refresh();

        toggleTagSettings();
        updateUI();
    }

    // ============================================
    // 初始化
    // ============================================

    jQuery(async () => {
        if (disposed) return;
        loadSettings();
        createUI();
        roleSelection = createRoleSelectionUI({
            host,
            getBatch: () => (settings.generationMode === 'role-batch' ? settings.roleBatch : null),
            isBusy: () => settings.isRunning || fileOperation,
            onReroll: rerollCurrentRole,
            onPreview: {
                compare: () =>
                    runRoleAction(async () => {
                        for (const notice of roleSuccessNotices) toastr.clear(notice);
                        roleSuccessNotices = [];
                        const batch = settings.roleBatch;
                        const comparison = await host.getRoleComparison(batch);
                        const show = host.getContext()?.Popup?.show?.text;
                        if (typeof show !== 'function') throw new Error('当前酒馆无法打开对比窗口');
                        const plan = buildRoleMergePlan(comparison.original, comparison.candidate);
                        await show('角色版本对比', renderRoleComparison(comparison), {
                            wide: true,
                            allowVerticalScrolling: true,
                            onOpen(popup) {
                                popup.dlg.classList.add('nag-compare-dialog');
                                if (!plan) return;
                                const area = popup.content.querySelector('.nag-merge-panel');
                                if (!area) return;
                                const output = area.querySelector('.nag-merge-output');
                                const status = area.querySelector('.nag-merge-status');
                                const save = area.querySelector('.nag-merge-save');
                                const preview = area.querySelector('.nag-merge-preview');
                                const back = area.querySelector('.nag-merge-back');
                                const blocks = area.querySelector('.nag-merge-blocks');
                                let draft = null,
                                    saving = false;
                                area.addEventListener('change', () => {
                                    draft = null;
                                    save.disabled = true;
                                    status.textContent = '选择已变化，请重新预览。';
                                });
                                preview.addEventListener('click', () => {
                                    const count = plan.filter((group) => group.type === 'choice').length;
                                    const selected = Array.from({ length: count }, (_, i) =>
                                        Array.from(
                                            area.querySelectorAll(`input[name="nag-merge-${i}"]:checked`),
                                            (input) => input.value,
                                        ),
                                    );
                                    try {
                                        const text = mergeRolePlan(plan, selected);
                                        const result = validateRoleMerge(
                                            comparison.original,
                                            comparison.candidate,
                                            text,
                                            host.parseYaml,
                                        );
                                        output.textContent = text;
                                        draft = result.ok ? text : null;
                                        save.disabled = !result.ok;
                                        status.textContent = result.message;
                                        output.hidden = false;
                                        blocks.hidden = true;
                                        preview.hidden = true;
                                        back.hidden = false;
                                        popup.content.scrollTop = 0;
                                    } catch (error) {
                                        draft = null;
                                        save.disabled = true;
                                        status.textContent = error.message;
                                    }
                                });
                                back.addEventListener('click', () => {
                                    output.hidden = true;
                                    blocks.hidden = false;
                                    preview.hidden = false;
                                    back.hidden = true;
                                    draft = null;
                                    save.disabled = true;
                                    status.textContent = '选择完成后请重新预览。';
                                    popup.content.scrollTop = 0;
                                });
                                save.addEventListener('click', async () => {
                                    if (saving || draft == null) return;
                                    saving = true;
                                    save.disabled = true;
                                    preview.disabled = true;
                                    const inputs = area.querySelectorAll('input');
                                    inputs.forEach((input) => {
                                        input.disabled = true;
                                    });
                                    let saved = false;
                                    try {
                                        const result = await host.saveMergedRolePreview(batch, comparison, draft, {
                                            minLength: settings.minChapterLength,
                                            expectedClosingTags: settings.expectedClosingTags,
                                        });
                                        saved = true;
                                        await popup.completeAffirmative();
                                        if (result.refreshFailed)
                                            toastr.warning('合并候选已保存，但页面刷新失败，请重新打开聊天查看');
                                        else toastr.success('合并内容已保存为新的候选页，请核对后决定是否替换原版');
                                    } catch (error) {
                                        recordError(error, { phase: 'merge-preview' });
                                        status.textContent = saved
                                            ? '合并候选已保存，但窗口关闭失败，请关闭窗口并核对聊天。'
                                            : error.uncertain
                                              ? `保存结果未确认，请关闭窗口并核对聊天：${error.message}`
                                              : error.message;
                                        save.disabled = saved || !!error.uncertain;
                                        preview.disabled = saved || !!error.uncertain;
                                    } finally {
                                        inputs.forEach((input) => {
                                            input.disabled = saved;
                                        });
                                        saving = false;
                                    }
                                });
                            },
                        });
                    }, 'preview-compare'),
                accept: () => runRoleAction(() => roleRunner.acceptPreview(), 'preview-accept'),
                again: () =>
                    runRoleAction(async () => {
                        if (settings.bufferModelStream) await bufferedStream.probe();
                        await roleRunner.rerollPreviewAgain();
                    }, 'preview-reroll'),
                discard: () => runRoleAction(() => roleRunner.discardPreview(), 'preview-discard'),
            },
            notify: (type, message) => toastr[type](message),
        });
        roleSelection.refresh();
        refreshTimer = setInterval(() => {
            if (settings.isRunning) updateUI();
        }, 1000);
        log('扩展已加载', 'success');
    });

    instance = {
        stop: () => {
            novelRunner.stop();
            roleRunner.stop();
        },
        dispose() {
            novelRunner.stop();
            roleRunner.stop();
            clearInterval(refreshTimer);
            disposed = true;
            cleanupHelp?.();
            closeRoleImagePreview();
            $('#nag-role-image-preview').remove();
            $(document).off('keydown.nagRoleImagePreview');
            resultIsolation?.dispose();
            roleSelection?.dispose();
            bufferedStream.dispose();
            $('#nag-container').remove();
            if (window.nagDebug === debugRawContent) delete window.nagDebug;
            instance = null;
        },
    };
    return instance;
}
