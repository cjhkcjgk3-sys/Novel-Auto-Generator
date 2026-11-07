import { afterEach, expect, it, vi } from 'vitest';
import { createBufferedStream } from '../../src/host/bufferedStream.js';

const savedFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const opts = {
    method: 'POST',
    headers: { 'X-CSRF-Token': 'fixture' },
    body: JSON.stringify({ stream: true, chat_completion_source: 'custom' }),
};

it('returns the stored stream in order and acknowledges it after consumption', async () => {
    const original = vi.fn(async (url, options) => {
        if (url.endsWith('/health')) return json({ version: 1, bootId: 'boot' });
        if (url.endsWith('/start')) {
            const body = JSON.parse(options.body);
            expect(body.bootId).toBe('boot');
            return json({ bootId: 'boot', id: body.id }, 202);
        }
        if (url.includes('/poll/'))
            return json({ bootId: 'boot', state: 'done', status: 200, offset: 3, data: btoa('abc') });
        if (url.includes('/ack/')) return new Response(null, { status: 204 });
        throw new Error('unexpected request');
    });
    globalThis.fetch = original;
    const adapter = createBufferedStream({ enabled: () => true });
    await adapter.probe();
    const response = await fetch('/api/backends/chat-completions/generate', opts);
    expect(await response.text()).toBe('abc');
    expect(original.mock.calls.some(([url]) => url.includes('/ack/'))).toBe(true);
    adapter.dispose();
});

it('does not silently fall back to an unbuffered request for unsupported or non-streaming generation', async () => {
    const original = vi.fn(async () => json({ version: 1, bootId: 'boot' }));
    globalThis.fetch = original;
    const adapter = createBufferedStream({ enabled: () => true });
    await adapter.probe();
    await expect(
        fetch('/api/backends/chat-completions/generate', { ...opts, body: JSON.stringify({ stream: false }) }),
    ).rejects.toThrow('流式');
    expect(original).toHaveBeenCalledTimes(1);
    adapter.dispose();
});

it('requests server cancellation when stopped during start', async () => {
    const original = vi.fn((url, options) => {
        if (url.endsWith('/health')) return Promise.resolve(json({ version: 1, bootId: 'boot' }));
        if (url.endsWith('/start'))
            return new Promise((resolve, reject) =>
                options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))),
            );
        if (url.includes('/cancel/')) return Promise.resolve(new Response(null, { status: 204 }));
        throw new Error('unexpected request');
    });
    globalThis.fetch = original;
    const adapter = createBufferedStream({ enabled: () => true });
    await adapter.probe();
    const controller = new AbortController();
    const pending = fetch('/api/backends/chat-completions/generate', { ...opts, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(original.mock.calls.some(([url]) => url.includes('/cancel/'))).toBe(true);
    adapter.dispose();
});

it('keeps checking after a gap in model output and delivers subsequent bytes', async () => {
    let polls = 0;
    const original = vi.fn(async (url) => {
        if (url.endsWith('/health')) return json({ version: 1, bootId: 'boot' });
        if (url.endsWith('/start')) return json({ bootId: 'boot' }, 202);
        if (url.includes('/poll/')) {
            polls++;
            if (polls === 1)
                return json({ bootId: 'boot', state: 'running', status: 200, offset: 3, data: btoa('abc') });
            if (polls === 2) return json({ bootId: 'boot', state: 'running', status: 200, offset: 3, data: '' });
            return json({ bootId: 'boot', state: 'done', status: 200, offset: 6, data: btoa('def') });
        }
        if (url.includes('/ack/')) return new Response(null, { status: 204 });
        throw new Error('unexpected request');
    });
    globalThis.fetch = original;
    const adapter = createBufferedStream({ enabled: () => true });
    await adapter.probe();
    const response = await fetch('/api/backends/chat-completions/generate', opts);
    expect(await response.text()).toBe('abcdef');
    expect(polls).toBe(3);
    adapter.dispose();
});

it('delivers buffered partial bytes and then reports a failed upstream', async () => {
    const onError = vi.fn();
    const original = vi.fn(async (url) => {
        if (url.endsWith('/health')) return json({ version: 1, bootId: 'boot' });
        if (url.endsWith('/start')) return json({ bootId: 'boot' }, 202);
        if (url.includes('/poll/'))
            return json({ bootId: 'boot', state: 'timeout', status: 200, offset: 3, data: btoa('abc') });
        throw new Error('unexpected request');
    });
    globalThis.fetch = original;
    const adapter = createBufferedStream({ enabled: () => true, onError });
    await adapter.probe();
    const response = await fetch('/api/backends/chat-completions/generate', opts);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc');
    await expect(reader.read()).rejects.toThrow('模型流中断');
    expect(onError).toHaveBeenCalledOnce();
    adapter.dispose();
});
