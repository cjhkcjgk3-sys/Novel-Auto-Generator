import { afterEach, expect, it } from 'vitest';
import { init, exit } from '../../server-plugins/novel-stream-buffer/index.mjs';

afterEach(() => exit());
function makeServer() {
    const routes = {};
    const router = {
        get: (path, fn) => {
            routes[`GET ${path}`] = fn;
        },
        post: (path, fn) => {
            routes[`POST ${path}`] = fn;
        },
    };
    init(router);
    const invoke = (route, req = {}) => {
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            },
            sendStatus(code) {
                this.statusCode = code;
                return this;
            },
        };
        routes[route](
            {
                user: { profile: { handle: 'alice' } },
                params: {},
                query: {},
                headers: {},
                socket: { localPort: 9 },
                ...req,
            },
            res,
        );
        return res;
    };
    return { invoke, bootId: invoke('GET /health').body.bootId };
}
const id = '11111111-1111-4111-8111-111111111111';
const payload = { stream: true, chat_completion_source: 'custom', messages: [] };

it('isolates jobs between users and makes repeated starts idempotent', () => {
    const { invoke, bootId } = makeServer();
    const req = { body: { id, payload, bootId } };
    expect(invoke('POST /start', req).statusCode).toBe(202);
    expect(invoke('POST /start', req).statusCode).toBe(202);
    expect(
        invoke('POST /start', { body: { ...req.body, payload: { ...payload, model: 'different' } } }).statusCode,
    ).toBe(409);
    expect(
        invoke('GET /poll/:id', { user: { profile: { handle: 'bob' } }, params: { id }, query: { offset: '0' } })
            .statusCode,
    ).toBe(404);
    expect(invoke('GET /poll/:id', { params: { id }, query: { offset: '0' } }).statusCode).toBe(200);
});

it('does not dispatch after cancellation or a server restart', () => {
    const { invoke, bootId } = makeServer();
    expect(invoke('POST /cancel/:id', { params: { id } }).statusCode).toBe(204);
    expect(invoke('GET /poll/:id', { params: { id }, query: { offset: '0' } }).body.state).toBe('cancelled');
    expect(invoke('POST /start', { body: { id, payload, bootId } }).statusCode).toBe(409);
    expect(invoke('POST /start', { body: { id, payload, bootId: 'old-server' } }).statusCode).toBe(409);
});
