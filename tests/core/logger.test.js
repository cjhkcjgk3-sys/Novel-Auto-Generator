import { expect, it } from 'vitest';
import { createErrorRecord } from '../../txtToWorldbook/core/logger.js';

it('exports only error context and source locations, never arbitrary request data', () => {
    const error = new Error('没有返回正文');
    error.stack = 'Error: 没有返回正文\n at run (https://host/private/src/host.js:14:2)';
    const record = createErrorRecord(error, {
        phase: 'select-swipe',
        roleIndex: 2,
        attempt: 3,
        expectedSwipe: 1,
        actualSwipe: 0,
        prompt: '私有提示词',
        response: '生成正文',
        apiKey: 'secret',
        settings: { token: 'secret' },
    });
    expect(record).toMatchObject({ phase: 'select-swipe', roleIndex: 2, attempt: 3, expectedSwipe: 1, actualSwipe: 0 });
    expect(record.locations).toEqual(['host.js:14:2']);
    expect(JSON.stringify(record)).not.toMatch(/私有提示词|生成正文|secret|private|https/);
});

it('redacts credentials and URLs and excludes multiline response details', () => {
    const record = createErrorRecord(
        new Error('401 api_key=abc123 token=secret Bearer sk-sensitive https://api.test/?key=secret\n完整生成正文'),
    );
    expect(record.message).toContain('401');
    expect(record.message).not.toMatch(/abc123|secret|sk-sensitive|https|完整生成正文/);
    expect(createErrorRecord(new Error('request: {"messages":["私有提示词"]}')).message).not.toContain('私有提示词');
    expect(createErrorRecord(new Error('{"api_key":"private-secret"}')).message).not.toContain('private-secret');
});
