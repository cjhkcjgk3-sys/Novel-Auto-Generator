import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { createCompletionCheck } from '../../server-plugins/novel-stream-buffer/index.mjs';

it('accepts complete OpenAI and Vertex event streams split across bytes', () => {
    for (const stream of [
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]},"finishReason":"STOP"}]}\n\n',
    ]) {
        const check = createCompletionCheck();
        for (const byte of Buffer.from(stream)) check.write(Buffer.from([byte]));
        expect(check.finish()).toBe('done');
    }
});

it('rejects an incomplete stream and preserves truncation despite a later DONE marker', () => {
    const missing = createCompletionCheck();
    missing.write(Buffer.from('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));
    expect(missing.finish()).toBe('incomplete');
    const truncated = createCompletionCheck();
    truncated.write(Buffer.from('data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
    expect(truncated.finish()).toBe('partial');
});
