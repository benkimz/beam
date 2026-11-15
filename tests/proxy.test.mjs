// Behind a TLS-terminating reverse proxy (the Docker image): PHP is executed, not
// served as source; X-Forwarded-Proto stops the HTTPS redirect looping; other hosts
// are not bounced to beamtm.com; mcp.php's loopback to agent.php works.
// Runs only against such a deployment: set BEAM_FORWARDED_PROTO=https (see helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BASE } from './helpers.mjs';

const skip = process.env.BEAM_FORWARDED_PROTO !== 'https' && 'set BEAM_FORWARDED_PROTO=https to run proxy tests';
const XFP = { 'X-Forwarded-Proto': 'https' };

// node:http rather than fetch, so the Host header can be set and redirects are not followed.
function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(path, BASE), { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('.php is executed, never served as source', { skip }, async () => {
  for (const p of ['/api/health.php', '/api/mcp.php', '/api/agent.php']) {
    const r = await req(p, { headers: XFP });
    assert.ok(!r.body.includes('<?php'), `${p} body contains PHP source`);
    assert.ok(!/x-httpd|php-source/.test(r.headers['content-type'] || ''), `${p} content-type ${r.headers['content-type']}`);
  }
  const h = await req('/api/health.php', { headers: XFP });
  assert.match(h.headers['content-type'], /^application\/json/);
  JSON.parse(h.body); // 404 {"error":"not found"} without a probe key; JSON either way
});

test('proxied HTTPS request to / is served, not redirected (no loop)', { skip }, async () => {
  const r = await req('/', { headers: XFP });
  assert.equal(r.status, 200);
  assert.match(r.body, /<html/i);
});

test('plain HTTP (no X-Forwarded-Proto) still redirects to https://beamtm.com', { skip }, async () => {
  const r = await req('/docs/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://beamtm.com/docs/');
});

test('another host over HTTPS is not redirected, except /index.html', { skip }, async () => {
  const headers = { ...XFP, Host: 'beam-staging.backdesk.co.ke' };
  for (const p of ['/', '/docs/', '/agents/', '/security/', '/assets/app.js']) {
    const r = await req(p, { headers });
    assert.equal(r.status, 200, `${p} -> ${r.status} ${r.headers.location || ''}`);
  }
  const idx = await req('/index.html', { headers });
  assert.equal(idx.status, 301);
  assert.equal(idx.headers.location, 'https://beamtm.com/');
});

test('www host is redirected to the apex', { skip }, async () => {
  const r = await req('/docs/', { headers: { ...XFP, Host: 'www.beamtm.com' } });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://beamtm.com/docs/');
});

test('mcp.php loopback to agent.php works for a non-local Host', { skip }, async () => {
  const headers = { ...XFP, Host: 'beam-staging.backdesk.co.ke', 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream' };
  const rpc = async (body, sid) => {
    const r = await req('/api/mcp.php', { method: 'POST', headers: sid ? { ...headers, 'Mcp-Session-Id': sid } : headers,
      body: JSON.stringify(body) });
    return { sid: r.headers['mcp-session-id'], d: JSON.parse(r.body) };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.ok(init.sid);
  const call = async (name, args, id) => JSON.parse((await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, init.sid)).d.result.content[0].text);
  const created = await call('beam_create_room', { ttl_hours: 1 }, 2);
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.equal((await call('beam_send', { code: created.code, message: 'via proxy' }, 3)).sent, true);
  assert.equal((await call('beam_end', { code: created.code }, 4)).ended, true);
});
