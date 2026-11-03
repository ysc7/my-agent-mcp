import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from './src/index.js';

const token = 'a'.repeat(32);
const messages: Record<string, unknown>[] = [];
const tasks: Record<string, unknown>[] = [];
const db = {
  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind(...v: unknown[]) { values = v; return this; },
      async all() {
        if (sql.startsWith('INSERT INTO message_feed')) { const [id, content, sender] = values; const recipient = values.length === 5 ? values[3] : null; const created_at = values[values.length - 1]; messages.push({ seq: messages.length + 1, id, content, sender, recipient, created_at }); return { results: [] }; }
        if (sql.startsWith('INSERT INTO tasks')) { const [id, title, description, assigned_to, created_at, updated_at] = values; tasks.push({ id, title, description, status: 'pending', claimed_by: null, assigned_to, created_at, updated_at }); return { results: [] }; }
        if (sql.includes('FROM message_feed')) {
          if (sql.includes('seq >')) return { results: messages.filter(m => (m.seq as number) > (values[0] as number) && (values.length === 1 || m.recipient === null || m.recipient === values[1])).slice(0, 100) };
          return { results: [...messages].filter(m => m.recipient === null).reverse() };
        }
        if (sql.includes('FROM tasks')) return { results: [...tasks].reverse() };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      async first() {
        if (sql.includes('INSERT INTO rate_limits')) return { request_count: 1, window_start: values[1] };
        if (sql.startsWith('UPDATE tasks SET status = \'claimed\'')) {
          const [claimant, updated_at, id, identity] = values; const task = tasks.find(t => t.id === id && t.status === 'pending' && (!identity || t.assigned_to === null || t.assigned_to === identity));
          if (task) Object.assign(task, { status: 'claimed', claimed_by: claimant, updated_at }); return task ?? null;
        }
        if (sql.startsWith('UPDATE tasks SET status = \'completed\'')) {
          const [updated_at, id, claimant] = values; const task = tasks.find(t => t.id === id && t.status === 'claimed' && t.claimed_by === claimant);
          if (task) Object.assign(task, { status: 'completed', updated_at }); return task ?? null;
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  },
};
const env = { DB: db, ADMIN_TOKEN: 'z'.repeat(32), AGENT_TOKENS: JSON.stringify({ alice: token }) };
const requests: { method: string; headers: Headers; body?: any; status: number }[] = [];
const localFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init); const copy = req.clone();
  const body = req.method === 'POST' ? await copy.json().catch(() => undefined) : undefined;
  const response = await worker.fetch(req, env as never);
  requests.push({ method: req.method, headers: req.headers, body, status: response.status });
  return response;
};
const url = new URL('https://worker.test/mcp');

test('official SDK Streamable HTTP interoperates with Worker and mocked D1', async () => {
  messages.length = 0; tasks.length = 0; requests.length = 0;
  const client = new Client({ name: 'interop-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'ai-company-mcp');
    assert.equal(transport.protocolVersion, '2025-03-26');
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['check_messages', 'claim_task', 'complete_task', 'create_message', 'create_task', 'get_identity', 'list_messages', 'list_tasks', 'send_message']);
    assert.deepEqual((await client.callTool({ name: 'get_identity', arguments: {} })).structuredContent, { identity: 'alice' });
    const created = await client.callTool({ name: 'create_message', arguments: { content: 'hello' } });
    assert.equal((created.structuredContent as any).message.sender, 'alice');
    const list = await client.callTool({ name: 'list_messages', arguments: {} });
    assert.equal((list.structuredContent as any).messages[0].content, 'hello');
    const direct = await client.callTool({ name: 'send_message', arguments: { to: 'alice', content: 'private' } });
    assert.equal((direct.structuredContent as any).message.sender, 'alice');
    const inbox = await client.callTool({ name: 'check_messages', arguments: {} });
    assert.equal((inbox.structuredContent as any).messages.length, 2);
    const empty = await client.callTool({ name: 'check_messages', arguments: { since: (inbox.structuredContent as any).next_cursor } });
    assert.equal((empty.structuredContent as any).messages.length, 0);
    const task = await client.callTool({ name: 'create_task', arguments: { title: 'interop', assigned_to: 'alice' } });
    assert.equal((task.structuredContent as any).task.assigned_to, 'alice');
    const id = (task.structuredContent as any).task.id;
    assert.equal(((await client.callTool({ name: 'claim_task', arguments: { id } })).structuredContent as any).task.claimed_by, 'alice');
    assert.equal(((await client.callTool({ name: 'complete_task', arguments: { id } })).structuredContent as any).task.status, 'completed');
    assert.equal((await client.callTool({ name: 'complete_task', arguments: { id } })).isError, true);
    assert.equal((await client.callTool({ name: 'create_message', arguments: { content: '' } })).isError, true);
    assert.ok(requests.some(r => r.body?.method === 'initialize' && r.status === 200));
    assert.ok(requests.some(r => r.body?.method === 'notifications/initialized' && r.status === 202));
    assert.ok(requests.some(r => r.body?.method === 'tools/list' && r.headers.get('mcp-protocol-version') === '2025-03-26'));
  } finally { await client.close(); }
});

test('raw transport edge cases expose protocol behavior', async () => {
  const rpc = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await worker.fetch(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) }), env as never);
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'not/a/method' });
  assert.equal(unknown.body.error.code, -32601);
  const invalidVersion = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-protocol-version': 'invalid' });
  assert.equal(invalidVersion.status, 400);
  // Current behavior: non-object JSON-RPC and null IDs do not produce a valid JSON-RPC error.
  const batch = await rpc([{ jsonrpc: '2.0', id: 3, method: 'ping' }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.body.jsonrpc, undefined);
  const badJsonRpc = await rpc({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.equal(badJsonRpc.body.error.code, -32600);
  const notification = await worker.fetch(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification' }) }), env as never);
  assert.equal(notification.status, 202);
});
