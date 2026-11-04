export function createLogger(initialLevel = 'INFO') {
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    let currentLevel = levels[initialLevel] ?? levels.INFO;

    const log = (level, tag, ...args) => {
        if (levels[level] >= currentLevel) {
            const timestamp = new Date().toISOString().slice(11, 23);
            const levelStr = level.padEnd(5);
            console.log(`[${timestamp}][${levelStr}][${tag}]`, ...args);
        }
    };

    return {
        levels,
        get currentLevel() {
            return currentLevel;
        },
        log,
        debug(tag, ...args) {
            log('DEBUG', tag, ...args);
        },
        info(tag, ...args) {
            log('INFO', tag, ...args);
        },
        warn(tag, ...args) {
            log('WARN', tag, ...args);
        },
        error(tag, ...args) {
            log('ERROR', tag, ...args);
        },
        setLevel(level) {
            if (levels[level] !== undefined) {
                currentLevel = levels[level];
            }
        },
    };
}

export const Logger = createLogger('INFO');

/** Error-only export record: never copy request objects, prompts, settings or response bodies. */
export function createErrorRecord(error, details = {}) {
    const clean = (value) =>
        String(value ?? '')
            .split(/\r?\n/, 1)[0]
            .replace(/(?:request|response|prompt|messages|body|提示词|正文)["']?\s*[:=][\s\S]*/gi, '[内容已省略]')
            .replace(/https?:\/\/\S+/gi, '[网址已省略]')
            .replace(/Bearer\s+\S+|\bsk-[\w-]+|\bAIza[\w-]+/gi, '[凭据已隐藏]')
            .replace(
                /((?:api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
                '$1[已隐藏]',
            )
            .slice(0, 600);
    const record = {
        time: new Date().toISOString(),
        name: clean(error?.name || 'Error'),
        message: clean(error?.message ?? error),
        code: clean(error?.code || ''),
    };
    for (const key of [
        'phase',
        'mode',
        'roleIndex',
        'attempt',
        'promptFloor',
        'resultFloor',
        'expectedSwipe',
        'actualSwipe',
        'generating',
        'pending',
        'uncertain',
        'status',
    ]) {
        const value = details[key] ?? error?.[key];
        if (['number', 'boolean'].includes(typeof value)) record[key] = value;
        else if (typeof value === 'string') record[key] = clean(value);
    }
    record.locations = [...String(error?.stack || '').matchAll(/[/\\]([^/\\\s]+\.m?js):(\d+):(\d+)/g)]
        .slice(0, 5)
        .map((match) => clean(`${match[1]}:${match[2]}:${match[3]}`));
    return record;
}
