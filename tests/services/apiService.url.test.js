import { describe, it, expect } from 'vitest';
import { buildChatUrl, buildModelsUrl } from '../../txtToWorldbook/services/apiService.js';

/**
 * 验证 OpenAI 兼容 API 的 URL 构造函数。
 *
 * 设计原则：
 *   - 遵循 OpenAI SDK 标准行为
 *   - 仅追加 /chat/completions 或 /models 后缀
 *   - 版本号路径由用户自行输入，不做智能识别
 */

describe('buildChatUrl', () => {
    describe('默认值', () => {
        it('空输入使用默认值并追加 /chat/completions', () => {
            expect(buildChatUrl('')).toBe('http://127.0.0.1:5000/v1/chat/completions');
            expect(buildChatUrl(undefined)).toBe('http://127.0.0.1:5000/v1/chat/completions');
            expect(buildChatUrl(null)).toBe('http://127.0.0.1:5000/v1/chat/completions');
        });
    });

    describe('标准 OpenAI 兼容 URL', () => {
        it('以 /v1 结尾追加 /chat/completions', () => {
            expect(buildChatUrl('http://localhost:5000/v1')).toBe('http://localhost:5000/v1/chat/completions');
            expect(buildChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
            expect(buildChatUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
        });

        it('以 /v2 结尾也追加 /chat/completions', () => {
            expect(buildChatUrl('https://qianfan.baidubce.com/v2')).toBe(
                'https://qianfan.baidubce.com/v2/chat/completions',
            );
        });

        it('以 /v3 结尾也追加 /chat/completions', () => {
            expect(buildChatUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
                'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            );
        });
    });

    describe('非标准 base URL (含附加路径)', () => {
        it('百度千帆 Coding Plan /v2/coding 追加 /chat/completions', () => {
            // 这是百度千帆 Coding Plan 的合法 base URL
            expect(buildChatUrl('https://qianfan.baidubce.com/v2/coding')).toBe(
                'https://qianfan.baidubce.com/v2/coding/chat/completions',
            );
        });

        it('火山引擎 ARK Coding /api/coding/v3 追加 /chat/completions', () => {
            // 这是火山引擎 coding plan 的合法 base URL
            expect(buildChatUrl('https://ark.cn-beijing.volces.com/api/coding/v3')).toBe(
                'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
            );
        });

        it('任意自定义路径追加 /chat/completions', () => {
            expect(buildChatUrl('http://my-proxy.internal/api/llm')).toBe(
                'http://my-proxy.internal/api/llm/chat/completions',
            );
            expect(buildChatUrl('https://example.com/some/long/prefix')).toBe(
                'https://example.com/some/long/prefix/chat/completions',
            );
        });
    });

    describe('已含 /chat/completions 的完整 URL', () => {
        it('不重复追加', () => {
            expect(buildChatUrl('https://api.openai.com/v1/chat/completions')).toBe(
                'https://api.openai.com/v1/chat/completions',
            );
            expect(buildChatUrl('https://qianfan.baidubce.com/v2/coding/chat/completions')).toBe(
                'https://qianfan.baidubce.com/v2/coding/chat/completions',
            );
        });
    });

    describe('末尾斜杠处理', () => {
        it('去除单个末尾斜杠', () => {
            expect(buildChatUrl('http://localhost:5000/v1/')).toBe('http://localhost:5000/v1/chat/completions');
        });

        it('去除多个末尾斜杠', () => {
            expect(buildChatUrl('http://localhost:5000/v1///')).toBe('http://localhost:5000/v1/chat/completions');
        });
    });

    describe('协议前缀处理', () => {
        it('缺失协议前缀的本地服务补 http://', () => {
            expect(buildChatUrl('localhost:5000/v1')).toBe('http://localhost:5000/v1/chat/completions');
            expect(buildChatUrl('127.0.0.1:5000/v1')).toBe('http://127.0.0.1:5000/v1/chat/completions');
        });

        it('缺失协议前缀的公网域名补 https://', () => {
            expect(buildChatUrl('api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
            expect(buildModelsUrl('api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/models');
        });

        it('保留 https://', () => {
            expect(buildChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
        });

        it('保留 http://', () => {
            expect(buildChatUrl('http://api.openai.com/v1')).toBe('http://api.openai.com/v1/chat/completions');
        });
    });
});

describe('buildModelsUrl', () => {
    describe('标准 base URL', () => {
        it('以 /v1 结尾追加 /models', () => {
            expect(buildModelsUrl('http://localhost:5000/v1')).toBe('http://localhost:5000/v1/models');
            expect(buildModelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
        });

        it('以 /api/v3 结尾追加 /models', () => {
            expect(buildModelsUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
                'https://ark.cn-beijing.volces.com/api/v3/models',
            );
        });

        it('自定义任意路径追加 /models', () => {
            expect(buildModelsUrl('https://qianfan.baidubce.com/v2/coding')).toBe(
                'https://qianfan.baidubce.com/v2/coding/models',
            );
            expect(buildModelsUrl('https://ark.cn-beijing.volces.com/api/coding/v3')).toBe(
                'https://ark.cn-beijing.volces.com/api/coding/v3/models',
            );
        });
    });

    describe('/chat/completions 替换为 /models', () => {
        it('替换 /chat/completions 后缀', () => {
            expect(buildModelsUrl('https://api.openai.com/v1/chat/completions')).toBe(
                'https://api.openai.com/v1/models',
            );
            expect(buildModelsUrl('https://qianfan.baidubce.com/v2/coding/chat/completions')).toBe(
                'https://qianfan.baidubce.com/v2/coding/models',
            );
        });
    });

    describe('已是 /models 结尾', () => {
        it('不重复追加', () => {
            expect(buildModelsUrl('https://api.openai.com/v1/models')).toBe('https://api.openai.com/v1/models');
            expect(buildModelsUrl('https://ark.cn-beijing.volces.com/api/v3/models')).toBe(
                'https://ark.cn-beijing.volces.com/api/v3/models',
            );
        });
    });

    describe('末尾斜杠和协议处理', () => {
        it('去除末尾斜杠', () => {
            expect(buildModelsUrl('http://localhost:5000/v1/')).toBe('http://localhost:5000/v1/models');
        });

        it('缺失协议前缀补 http://', () => {
            expect(buildModelsUrl('localhost:5000/v1')).toBe('http://localhost:5000/v1/models');
        });

        it('保留 https://', () => {
            expect(buildModelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
        });
    });
});
