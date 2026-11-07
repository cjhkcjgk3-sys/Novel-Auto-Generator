const ROOT = '/api/plugins/novel-stream-buffer';
const PATH = '/api/backends/chat-completions/generate';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Intercepts only active-task OpenAI-compatible/Vertex streaming requests. */
export function createBufferedStream({ enabled, onError = () => {} }) {
    const original = globalThis.fetch;
    let bootId = null;
    let disposed = false;
    async function probe() {
        const response = await original(`${ROOT}/health`, { cache: 'no-store' });
        if (!response.ok) throw new Error('服务器缓冲组件未安装或未启用');
        const data = await response.json();
        if (data.version !== 1 || !data.bootId) throw new Error('服务器缓冲组件版本不兼容');
        bootId = data.bootId;
    }
    async function waitRequest(url, options, signal) {
        for (;;) {
            if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
            try {
                const result = await original(url, { ...options, signal });
                if (result.status >= 500) throw new Error('服务器暂不可用');
                return result;
            } catch (error) {
                if (signal?.aborted) throw error;
                await delay(1500);
            }
        }
    }
    async function buffered(input, options) {
        const payload = JSON.parse(options.body);
        const source = payload.chat_completion_source;
        if (!payload.stream) throw new Error('服务器暂存需要开启流式输出');
        if (!['openai', 'custom', 'vertexai'].includes(source))
            throw new Error('服务器暂存仅支持 OpenAI 兼容和 Vertex AI 接口');
        if (!bootId || !globalThis.crypto?.randomUUID) throw new Error('服务器缓冲未就绪或浏览器不支持安全标识');
        const signal = options.signal;
        const id = crypto.randomUUID();
        const headers = new Headers(options.headers);
        headers.set('Content-Type', 'application/json');
        let cancelled = false;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            void original(`${ROOT}/cancel/${id}`, { method: 'POST', headers, keepalive: true }).catch(() => {});
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const start = await waitRequest(
                `${ROOT}/start`,
                { method: 'POST', headers, body: JSON.stringify({ id, payload, bootId }) },
                signal,
            );
            if (!start.ok) throw new Error(`缓冲任务启动失败 (${start.status})`);
            const started = await start.json();
            if (started.bootId !== bootId) throw new Error('酒馆服务重启，当前请求状态无法确认');
            let offset = 0,
                first = null;
            async function poll() {
                const response = await waitRequest(
                    `${ROOT}/poll/${id}?offset=${offset}`,
                    { cache: 'no-store' },
                    signal,
                );
                if (!response.ok) throw new Error(`缓冲任务不可用 (${response.status})`);
                const data = await response.json();
                if (data.bootId !== bootId) throw new Error('酒馆服务重启，缓冲结果已丢失');
                return data;
            }
            while (!first?.status) {
                first = await poll();
                if (first.state !== 'running' && !first.status) throw new Error(`模型连接中断 (${first.state})`);
                if (!first.status) await delay(500);
            }
            const status = first.status;
            let terminalError = null;
            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        if (terminalError) throw terminalError;
                        for (;;) {
                            const data = first || (await poll());
                            first = null;
                            if (data.data) {
                                const bytes = Uint8Array.from(atob(data.data), (x) => x.charCodeAt(0));
                                if (data.offset !== offset + bytes.length) throw new Error('缓冲数据顺序不一致');
                                offset = data.offset;
                                controller.enqueue(bytes);
                            }
                            if (data.state === 'done') {
                                signal?.removeEventListener('abort', cancel);
                                controller.close();
                                void original(`${ROOT}/ack/${id}`, { method: 'POST', headers, keepalive: true }).catch(
                                    () => {},
                                );
                                return;
                            }
                            if (data.state !== 'running') {
                                terminalError = Object.assign(new Error(`模型流中断 (${data.state})`), {
                                    uncertain: true,
                                });
                                if (!data.data) throw terminalError;
                                return;
                            }
                            if (data.data) return;
                            await delay(500);
                        }
                    } catch (error) {
                        signal?.removeEventListener('abort', cancel);
                        if (!signal?.aborted) onError(error);
                        controller.error(error);
                    }
                },
                cancel() {
                    signal?.removeEventListener('abort', cancel);
                    cancel();
                },
            });
            return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
        } catch (error) {
            signal?.removeEventListener('abort', cancel);
            if (signal?.aborted) cancel();
            throw error;
        }
    }
    const wrapper = (input, options = {}) => {
        if (
            disposed ||
            !enabled() ||
            typeof input !== 'string' ||
            input !== PATH ||
            options.method !== 'POST' ||
            typeof options.body !== 'string'
        )
            return original(input, options);
        return buffered(input, options);
    };
    globalThis.fetch = wrapper;
    return {
        probe,
        dispose() {
            disposed = true;
            if (globalThis.fetch === wrapper) globalThis.fetch = original;
        },
    };
}
