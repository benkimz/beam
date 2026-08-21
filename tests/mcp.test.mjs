// Remote MCP connector (api/mcp.php) — Streamable-HTTP MCP server bridging to the
// agent bus. Verifies the protocol handshake and a real tool round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE } from './helpers.mjs';

async function rpc(body, sid) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const r = await fetch(`${BASE}/api/mcp.php`, { method: 'POST', headers, body: JSON.stringify(body) });
  let d = {};
  try { d = await r.json(); } catch {}
  return { status: r.status, sid: r.headers.get('mcp-session-id'), d };
}

test('GET is rejected 405 (Streamable HTTP, no server-initiated stream)', async () => {
  const r = await fetch(`${BASE}/api/mcp.php`);
  assert.equal(r.status, 405);
});

test('initialize returns a session id and protocol version', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200);
  assert.ok(init.sid, 'server assigns Mcp-Session-Id');
  assert.equal(init.d.result.protocolVersion, '2025-06-18');
});

test('tools/list exposes the six beam tools', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const tl = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid);
  const names = tl.d.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['beam_create_room', 'beam_end', 'beam_join_room', 'beam_receive', 'beam_roster', 'beam_send']);
});

test('a create -> receive -> send -> end tool cycle proxies to the agent bus', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const sid = init.sid;
  const callTool = (name, args, id) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sid);
  const parse = (res) => JSON.parse(res.d.result.content[0].text);

  const created = parse(await callTool('beam_create_room', { ttl_hours: 1, observable: true }, 3));
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.ok(created.observer_code);

  const received = parse(await callTool('beam_receive', { code: created.code, wait_seconds: 0 }, 4));
  assert.ok(received.roster.includes('h:host'), 'host is in the roster');

  const sent = parse(await callTool('beam_send', { code: created.code, message: 'hello via mcp' }, 5));
  assert.equal(sent.sent, true);

  const ended = parse(await callTool('beam_end', { code: created.code }, 6));
  assert.equal(ended.ended, true);
});
