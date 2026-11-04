import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Silent mode and swipe hiding settings', () => {
    const runtimePath = path.resolve(__dirname, '../../src/novel/runtime.js');
    const stylePath = path.resolve(__dirname, '../../style.css');

    it('defines hideSwipes and hideChatHistory in runtime.js defaultSettings', () => {
        const content = fs.readFileSync(runtimePath, 'utf8');
        expect(content).toContain('hideSwipes: false');
        expect(content).toContain('hideChatHistory: false');
        expect(content).toContain('function applySilentClasses()');
        expect(content).toContain('nag-hide-swipes');
        expect(content).toContain('nag-hide-history');
    });

    it('contains CSS rules to hide candidate replies and prior history', () => {
        const css = fs.readFileSync(stylePath, 'utf8');
        expect(css).toContain('body.nag-hide-swipes');
        expect(css).toContain('body.nag-hide-history');
        expect(css).toContain('display: none !important;');
        expect(css).toContain('🔒 备选回复已完全隐藏');
    });
});
