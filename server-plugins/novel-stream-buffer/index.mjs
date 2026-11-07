import http from 'node:http';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';

export const info = {
    id: 'novel-stream-buffer',
    name: 'Novel stream buffer',
    description: 'Buffer one active streaming generation per user',
};
const jobs = new Map();
const bootId = crypto.randomUUID();
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_JOBS_PER_USER = 100;
const MAX_AGE = 15 * 60 * 1000;
const IDLE_MS = 3 * 60 * 1000;
let cleanupTimer;
const handle = (request) => request.user?.profile?.handle;
const key = (owner, id) => `${owner}:${id}`;
const hash = (payload) => crypto.createHash('sha256').update(payload).digest('hex');
function terminate(job, reason) {
    if (job.state !== 'running') return;
    job.state = reason;
    clearTimeout(job.idleTimer);
    job.source?.destroy();
    job.request?.destroy();
}
function resetIdle(job) {
    clearTimeout(job.idleTimer);
    job.idleTimer = setTimeout(() => terminate(job, 'timeout'), IDLE_MS);
    job.idleTimer.unref();
}
export function createCompletionCheck() {
    const decoder = new StringDecoder('utf8');
    let pending = '',
        valid = false,
        truncated = false;
    function line(value) {
        if (!value.startsWith('data:')) return;
        const data = value.slice(5).trim();
        if (data === '[DONE]') {
            valid = true;
            return;
        }
        try {
            const obj = JSON.parse(data);
            const reason = obj.choices?.[0]?.finish_reason ?? obj.candidates?.[0]?.finishReason;
            if (reason != null) {
                const normalized = String(reason).toLowerCase();
                if (['stop', 'tool_calls', 'function_call', 'end_turn', 'stop_sequence'].includes(normalized))
                    valid = true;
                else truncated = true;
            }
        } catch {
            /* Partial JSON or provider-specific events do not prove completion. */
        }
    }
    function consume(text) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const value of lines) line(value.replace(/\r$/, ''));
    }
    return {
        write: (chunk) => consume(decoder.write(chunk)),
        finish: () => {
            consume(decoder.end());
            if (pending) line(pending.replace(/\r$/, ''));
            return truncated ? 'partial' : valid ? 'done' : 'incomplete';
        },
    };
}
function owned(req) {
    return jobs.get(key(handle(req), req.params.id));
}
export function init(router) {
    router.get('/health', (req, res) => res.json({ version: 1, bootId }));
    router.post('/start', (req, res) => {
        const owner = handle(req),
            id = req.body?.id,
            payload = req.body?.payload;
        if (
            !owner ||
            !/^[a-f0-9-]{36}$/i.test(id || '') ||
            !payload ||
            payload.stream !== true ||
            !['openai', 'custom', 'vertexai'].includes(payload.chat_completion_source)
        )
            return res.status(400).json({ error: 'unsupported_request' });
        if (req.body?.bootId !== bootId) return res.status(409).json({ error: 'server_restarted' });
        const raw = JSON.stringify(payload),
            idKey = key(owner, id),
            payloadHash = hash(raw);
        const old = jobs.get(idKey);
        if (old?.state === 'cancelled') return res.status(409).json({ error: 'cancelled' });
        if (old)
            return old.hash === payloadHash
                ? res.status(202).json({ id, bootId })
                : res.status(409).json({ error: 'id_conflict' });
        if ([...jobs.values()].filter((j) => j.owner === owner).length >= MAX_JOBS_PER_USER)
            return res.status(429).json({ error: 'too_many_jobs' });
        if ([...jobs.values()].some((j) => j.owner === owner && j.state === 'running'))
            return res.status(409).json({ error: 'already_running' });
        const job = {
            owner,
            id,
            hash: payloadHash,
            state: 'running',
            status: null,
            chunks: [],
            size: 0,
            created: Date.now(),
            request: null,
            source: null,
            idleTimer: null,
        };
        jobs.set(idKey, job);
        const headers = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
            'accept-encoding': 'identity',
        };
        for (const header of ['cookie', 'authorization', 'x-csrf-token'])
            if (req.headers[header]) headers[header] = req.headers[header];
        const completion = createCompletionCheck();
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port: req.socket.localPort,
                path: '/api/backends/chat-completions/generate',
                method: 'POST',
                headers,
            },
            (response) => {
                job.source = response;
                job.status = response.statusCode;
                resetIdle(job);
                response.on('data', (chunk) => {
                    if (job.state !== 'running') return;
                    resetIdle(job);
                    const total = [...jobs.values()].reduce((n, item) => n + (item.size || 0), 0);
                    if (job.size + chunk.length > MAX_BYTES || total + chunk.length > MAX_TOTAL_BYTES)
                        return terminate(job, 'overflow');
                    job.size += chunk.length;
                    job.chunks.push(chunk);
                    completion.write(chunk);
                });
                response.on('end', () => {
                    if (job.state === 'running') {
                        clearTimeout(job.idleTimer);
                        job.state = job.status >= 400 ? 'done' : completion.finish();
                    }
                });
                response.on('error', () => terminate(job, 'error'));
                response.on('close', () => {
                    if (!response.complete) terminate(job, 'error');
                });
            },
        );
        job.request = request;
        request.on('error', () => terminate(job, 'error'));
        resetIdle(job);
        request.end(raw);
        res.status(202).json({ id, bootId });
    });
    router.get('/poll/:id', (req, res) => {
        const job = owned(req);
        if (!job) return res.sendStatus(404);
        const offset = Number(req.query.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.size) return res.sendStatus(400);
        const data = Buffer.concat(job.chunks, job.size).subarray(offset);
        res.json({ bootId, state: job.state, status: job.status, offset: job.size, data: data.toString('base64') });
    });
    router.post('/cancel/:id', (req, res) => {
        const owner = handle(req),
            id = req.params.id;
        if (!owner || !/^[a-f0-9-]{36}$/i.test(id)) return res.sendStatus(400);
        const job = owned(req);
        if (job) terminate(job, 'cancelled');
        else {
            if ([...jobs.values()].filter((j) => j.owner === owner).length >= MAX_JOBS_PER_USER)
                return res.sendStatus(429);
            jobs.set(key(owner, id), {
                owner,
                id,
                state: 'cancelled',
                status: null,
                chunks: [],
                size: 0,
                created: Date.now(),
            });
        }
        res.sendStatus(204);
    });
    router.post('/ack/:id', (req, res) => {
        const job = owned(req);
        if (!job) return res.sendStatus(404);
        if (job.state === 'running') return res.sendStatus(409);
        jobs.delete(key(job.owner, job.id));
        res.sendStatus(204);
    });
    cleanupTimer = setInterval(() => {
        for (const [id, job] of jobs)
            if (Date.now() - job.created > MAX_AGE) {
                terminate(job, 'expired');
                jobs.delete(id);
            }
    }, 60000);
    cleanupTimer.unref();
}
export function exit() {
    clearInterval(cleanupTimer);
    for (const job of jobs.values()) terminate(job, 'shutdown');
    jobs.clear();
}
