import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Silent mode and model context isolation', () => {
    const runtimePath = path.resolve(__dirname, '../../src/novel/runtime.js');
    const stylePath = path.resolve(__dirname, '../../style.css');

    it('defines hideHistoryFromModel in runtime.js defaultSettings', () => {
        const content = fs.readFileSync(runtimePath, 'utf8');
        expect(content).toContain('hideHistoryFromModel: false');
        expect(content).toContain('function syncHistoryModelVisibility()');
        expect(content).toContain('#nag-set-hide-history-model');
    });

    it('does not physically lock out or blackout user screen with display:none in style.css', () => {
        const css = fs.readFileSync(stylePath, 'utf8');
        expect(css).not.toContain('body.nag-hide-swipes');
        expect(css).not.toContain('body.nag-hide-history');
    });
});
