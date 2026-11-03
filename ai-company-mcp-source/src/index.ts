// Stateless Streamable HTTP MCP and a separately authenticated administrative API.
interface D1Result<T> { results: T[] }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
interface D1Database { prepare(query: string): D1Statement }
interface Env { DB: D1Database; ADMIN_TOKEN?: string; AGENT_TOKENS?: string }
type Obj = Record<string, unknown>;
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
});
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function exact(o: Obj, keys: string[]) { if (Object.keys(o).some(k => !keys.includes(k))) throw new HttpError(400, 'Unexpected field'); }
function text(v: unknown, name: string, max: number, optional = false): string {
  if (optional && v === undefined) return '';
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new HttpError(400, `Invalid ${name}`);
  return v.trim();
}
async function body(req: Request): Promise<Obj> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'Expected application/json');
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 16384)) throw new HttpError(413, 'Body too large');
  if (!req.body) throw new HttpError(400, 'Missing body');
  const reader = req.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new HttpError(413, 'Body too large'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  try { const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!obj(parsed)) throw new Error(); return parsed; } catch { throw new HttpError(400, 'Invalid JSON object'); }
}
async function equal(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder(); const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let diff = 0; for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]; return diff === 0;
}
async function authenticate(req: Request, env: Env, kind: 'admin' | 'mcp'): Promise<string> {
  // All credentials must be random secrets provisioned out of band, never committed.
  let agents: unknown; try { agents = JSON.parse(env.AGENT_TOKENS || ''); } catch { throw new HttpError(503, 'Authentication is not configured'); }
  if (!env.ADMIN_TOKEN || !/^[\x21-\x7e]{32,512}$/.test(env.ADMIN_TOKEN) || !obj(agents) || !Object.keys(agents).length || Object.keys(agents).length > 100) throw new HttpError(503, 'Authentication is not configured');
  const entries = Object.entries(agents); const seen = new Set<string>([env.ADMIN_TOKEN]);
  for (const [name, token] of entries) {
    if (name.toLowerCase() === 'admin' || !/^[a-zA-Z0-9_-]{1,100}$/.test(name) || typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token) || seen.has(token)) throw new HttpError(503, 'Authentication is not configured');
    seen.add(token);
  }
  const header = req.headers.get('authorization') || ''; const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(header);
  if (!match) throw new HttpError(401, 'Unauthorized');
  if (kind === 'admin') { if (await equal(match[1], env.ADMIN_TOKEN)) return 'admin'; }
  else { for (const [name, token] of entries) if (await equal(match[1], token as string)) return name; }
  throw new HttpError(401, 'Unauthorized');
}
// A single atomic UPSERT serializes concurrent requests, including across Worker instances.
// Identity names are stable across token rotation; the namespace prevents role collisions.
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;
async function rateLimit(db: D1Database, identity: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS;
  let row: { request_count: number; window_start: number } | null;
  try {
    row = await db.prepare(`INSERT INTO rate_limits (identity, window_start, request_count) VALUES (?, ?, 1)
      ON CONFLICT(identity) DO UPDATE SET
        request_count = CASE WHEN window_start < excluded.window_start THEN 1 ELSE MIN(request_count + 1, ?) END,
        window_start = MAX(window_start, excluded.window_start)
      RETURNING request_count, window_start`).bind(identity, window, RATE_LIMIT + 1).first<{ request_count: number; window_start: number }>();
    if (!row || !Number.isSafeInteger(row.request_count) || row.request_count < 1 || !Number.isSafeInteger(row.window_start)) throw new Error('Invalid rate limit result');
  } catch (e) {
    console.error('Rate limit storage failed', e);
    throw new HttpError(503, 'Rate limit unavailable');
  }
  if (row.request_count > RATE_LIMIT) throw new RateLimitError(Math.max(1, row.window_start + RATE_WINDOW_SECONDS - now));
}
class RateLimitError extends HttpError {
  readonly retryAfter: number;
  constructor(retryAfter: number) { super(429, 'Rate limit exceeded'); this.retryAfter = retryAfter; }
}
function originCheck(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'Origin not allowed');
}
async function execute(db: D1Database, name: string, args: Obj, identity?: string, agentNames: string[] = []): Promise<unknown> {
  const now = new Date().toISOString();
  switch (name) {
    case 'get_identity': {
      exact(args, []); return { identity };
    }
    case 'list_messages': {
      exact(args, []); return { messages: (await db.prepare('SELECT id, content, sender, created_at FROM message_feed WHERE recipient IS NULL ORDER BY created_at DESC, id DESC LIMIT 100').all()).results };
    }
    case 'create_message': {
      exact(args, ['content']); const content = text(args.content, 'content', 4000); const id = crypto.randomUUID();
      const sender = identity || 'admin';
      await db.prepare('INSERT INTO message_feed (id, content, sender, recipient, created_at) VALUES (?, ?, ?, NULL, ?)').bind(id, content, sender, now).all();
      return { message: { id, content, sender, created_at: now } };
    }
    case 'send_message': {
      exact(args, identity ? ['to', 'content', 'idempotency_key'] : ['to', 'content']);
      const to = text(args.to, 'to', 100), content = text(args.content, 'content', 4000);
      const key = args.idempotency_key === undefined ? undefined : text(args.idempotency_key, 'idempotency_key', 200);
      if (!agentNames.includes(to)) throw new HttpError(400, 'Unknown recipient');
      const id = crypto.randomUUID(), sender = identity || 'admin';
      if (key !== undefined) {
        // One statement both creates the message and returns the winner on a concurrent retry.
        const message = await db.prepare(`INSERT INTO message_feed (id, content, sender, recipient, created_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sender, idempotency_key) DO UPDATE SET idempotency_key = excluded.idempotency_key
          RETURNING id, content, sender, recipient, created_at`).bind(id, content, sender, to, now, key).first<{ id: string; content: string; sender: string; recipient: string; created_at: string }>();
        if (!message) throw new Error('Message insert returned no receipt');
        if (message.recipient !== to || message.content !== content) throw new HttpError(409, 'Idempotency key conflict');
        return { message };
      }
      await db.prepare('INSERT INTO message_feed (id, content, sender, recipient, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, content, sender, to, now).all();
      return { message: { id, content, sender, recipient: to, created_at: now } };
    }
    case 'check_messages': {
      exact(args, ['since']);
      const since = args.since === undefined ? 0 : args.since;
      if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Invalid since');
      const sql = identity ? 'SELECT seq, id, content, sender, recipient, created_at FROM message_feed WHERE seq > ? AND (recipient IS NULL OR recipient = ?) ORDER BY seq ASC LIMIT 100' : 'SELECT seq, id, content, sender, recipient, created_at FROM message_feed WHERE seq > ? ORDER BY seq ASC LIMIT 100';
      const statement = db.prepare(sql);
      const messages = (await (identity ? statement.bind(since, identity) : statement.bind(since)).all<{ seq: number }>()).results;
      return { messages, next_cursor: messages.length ? messages[messages.length - 1].seq : since };
    }
    case 'list_tasks': {
      exact(args, []); return { tasks: (await db.prepare('SELECT id, title, description, status, claimed_by, assigned_to, created_at, updated_at FROM tasks ORDER BY created_at DESC, id DESC LIMIT 100').all()).results };
    }
    case 'create_task': {
      exact(args, ['title', 'description', 'assigned_to']); const title = text(args.title, 'title', 200), description = text(args.description, 'description', 4000, true), id = crypto.randomUUID();
      const assigned_to = args.assigned_to === undefined ? null : text(args.assigned_to, 'assigned_to', 100);
      if (assigned_to !== null && assigned_to !== 'admin' && !agentNames.includes(assigned_to)) throw new HttpError(400, 'Unknown assigned_to');
      await db.prepare("INSERT INTO tasks (id, title, description, status, claimed_by, assigned_to, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)").bind(id, title, description, assigned_to, now, now).all();
      return { task: { id, title, description, status: 'pending', claimed_by: null, assigned_to, created_at: now, updated_at: now } };
    }
    case 'release_task': {
      exact(args, ['id']); const id = text(args.id, 'id', 36);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, 'Invalid id');
      const task = await db.prepare("UPDATE tasks SET status = 'pending', claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' RETURNING *").bind(now, id).first();
      if (!task) throw new HttpError(409, 'Task not found or state conflict');
      return { task };
    }
    case 'claim_task': case 'complete_task': {
      exact(args, identity ? ['id'] : ['id', 'claimant']);
      const id = text(args.id, 'id', 36), claimant = identity || text(args.claimant, 'claimant', 100);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, 'Invalid id');
      const sql = name === 'claim_task'
        ? `UPDATE tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'${identity ? ' AND (assigned_to IS NULL OR assigned_to = ?)' : ''} RETURNING *`
        : "UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ? RETURNING *";
      const statement = db.prepare(sql);
      const task = await (name === 'claim_task' ? statement.bind(...(identity ? [claimant, now, id, identity] : [claimant, now, id])) : statement.bind(now, id, claimant)).first();
      if (!task) throw new HttpError(409, 'Task not found or state/claimant conflict');
      return { task };
    }
    default: throw new HttpError(404, 'Not found');
  }
}
const schemas: Record<string, Obj> = {
  get_identity: { type: 'object', properties: {}, additionalProperties: false },
  send_message: { type: 'object', properties: { to: { type: 'string', minLength: 1, maxLength: 100, description: 'Configured agent recipient' }, content: { type: 'string', minLength: 1, maxLength: 4000 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional sender-scoped retry key' } }, required: ['to', 'content'], additionalProperties: false },
  check_messages: { type: 'object', properties: { since: { type: 'integer', minimum: 0, description: 'Exclusive cursor from next_cursor; default 0' } }, additionalProperties: false },
  list_messages: { type: 'object', properties: {}, additionalProperties: false },
  create_message: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['content'], additionalProperties: false },
  list_tasks: { type: 'object', properties: {}, additionalProperties: false },
  create_task: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 4000 }, assigned_to: { type: 'string', minLength: 1, maxLength: 100, description: 'Configured agent name or admin; omit for any agent' } }, required: ['title'], additionalProperties: false },
  claim_task: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false },
  complete_task: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false }
};
const rpcError = (id: unknown, code: number, message: string) => json({ jsonrpc: '2.0', id, error: { code, message } });
async function mcp(req: Request, env: Env, identity: string): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed; stateless POST only' }, 405, { allow: 'POST' });
  const version = req.headers.get('mcp-protocol-version');
  if (version && !['2025-03-26', '2025-06-18'].includes(version)) return json({ error: 'Unsupported MCP protocol version' }, 400);
  const msg = await body(req); const id = msg.id;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (id !== undefined && typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id)))) return rpcError(null, -32600, 'Invalid Request');
  if (id === undefined) return new Response(null, { status: 202 });
  const ok = (result: unknown) => json({ jsonrpc: '2.0', id, result });
  if (msg.method === 'initialize') {
    if (!obj(msg.params) || typeof msg.params.protocolVersion !== 'string') return rpcError(id, -32602, 'Invalid params');
    const supported = ['2025-03-26', '2025-06-18']; const version = supported.includes(msg.params.protocolVersion) ? msg.params.protocolVersion : '2025-03-26';
    return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'ai-company-mcp', version: '0.1.0' } });
  }
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: Object.entries(schemas).map(([name, inputSchema]) => ({ name, description: name.replace('_', ' '), inputSchema })) });
  if (msg.method === 'tools/call') {
    if (!obj(msg.params) || typeof msg.params.name !== 'string' || !Object.hasOwn(schemas, msg.params.name) || (msg.params.arguments !== undefined && !obj(msg.params.arguments))) return rpcError(id, -32602, 'Invalid tool or arguments');
    try { const result = await execute(env.DB, msg.params.name, (msg.params.arguments || {}) as Obj, identity, Object.keys(JSON.parse(env.AGENT_TOKENS!))); return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }); }
    catch (e) { if (e instanceof HttpError) return ok({ content: [{ type: 'text', text: e.message }], isError: true }); throw e; }
  }
  return rpcError(id, -32601, 'Method not found');
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url); originCheck(req);
      if (url.pathname === '/mcp') { const identity = await authenticate(req, env, 'mcp'); await rateLimit(env.DB, `agent:${identity}`); return await mcp(req, env, identity); }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      const identity = await authenticate(req, env, 'admin');
      await rateLimit(env.DB, `admin:${identity}`);
      if (url.pathname === '/api/inbox' && req.method === 'GET') {
        const keys: string[] = []; url.searchParams.forEach((_value, key) => keys.push(key));
        if (keys.some(k => k !== 'since') || keys.length > 1) throw new HttpError(400, 'Invalid query parameters');
        const raw = url.searchParams.get('since');
        if (raw !== null && !/^(0|[1-9]\d*)$/.test(raw)) throw new HttpError(400, 'Invalid since');
        return json(await execute(env.DB, 'check_messages', raw === null ? {} : { since: Number(raw) }));
      }
      if (url.search) throw new HttpError(400, 'Query parameters are not supported');
      if (url.pathname === '/api/direct-messages' && req.method === 'POST') return json(await execute(env.DB, 'send_message', await body(req), undefined, Object.keys(JSON.parse(env.AGENT_TOKENS!))), 201);
      if (url.pathname === '/api/messages' && req.method === 'GET') return json(await execute(env.DB, 'list_messages', {}));
      if (url.pathname === '/api/messages' && req.method === 'POST') return json(await execute(env.DB, 'create_message', await body(req)), 201);
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(await execute(env.DB, 'list_tasks', {}));
      if (url.pathname === '/api/tasks' && req.method === 'POST') return json(await execute(env.DB, 'create_task', await body(req), undefined, Object.keys(JSON.parse(env.AGENT_TOKENS!))), 201);
      const match = /^\/api\/tasks\/([^/]+)\/(claim|complete|release)$/.exec(url.pathname);
      if (match && req.method === 'POST') {
        if (match[2] === 'release') { const input = await body(req); exact(input, []); return json(await execute(env.DB, 'release_task', { id: match[1] })); }
        const input = await body(req); exact(input, ['claimant']); return json(await execute(env.DB, match[2] === 'claim' ? 'claim_task' : 'complete_task', { id: match[1], claimant: input.claimant }));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e instanceof RateLimitError ? { 'retry-after': String(e.retryAfter) } : e.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      console.error('Request failed', e); return json({ error: 'Internal server error' }, 500);
    }
  }
};
