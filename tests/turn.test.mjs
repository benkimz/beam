// TURN relay credentials (beam.php action "ice"). Needs beam started with
//   BEAM_TURN_ENABLED=1 BEAM_TURN_KEY_ID=<id> BEAM_TURN_API_TOKEN=<token>
//   BEAM_TURN_API_BASE=http://<stub host>:8787/v1
// and the stub (tests/turn-stub.mjs) running. Set in the test environment:
//   BEAM_TURN_STUB      the stub's control URL (e.g. http://127.0.0.1:8788)
//   BEAM_TURN_API_TOKEN the same token, so we can check it never leaks
//   BEAM_TURN_OFF_BASE  (optional) a second beam started with BEAM_TURN_ENABLED=0
//   BEAM_TURN_EMPTY_BASE (optional) a beam started with BEAM_TURN_ENABLED=1 but an
//                       empty BEAM_TURN_KEY_ID and a blank BEAM_TURN_API_TOKEN (as
//                       compose env_file passes unset values), API base on the stub
//   BEAM_CONTAINER      (optional) container name, to check logs and the data dir
// The STUN-only and auth tests also run against any beam without TURN configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BASE, PROXY_HEADERS } from './helpers.mjs';

const STUB = process.env.BEAM_TURN_STUB;
const TOKEN = process.env.BEAM_TURN_API_TOKEN;
const OFF_BASE = process.env.BEAM_TURN_OFF_BASE;
const EMPTY_BASE = process.env.BEAM_TURN_EMPTY_BASE;
const C = process.env.BEAM_CONTAINER;
const needStub = !STUB && 'set BEAM_TURN_STUB (and run beam against tests/turn-stub.mjs) for TURN tests';
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const bodies = []; // every raw response body, checked for the API token at the end

async function call(payload, base = BASE) {
  const r = await fetch(`${base}/api/beam.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PROXY_HEADERS },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  bodies.push(text);
  let d = {};
  try { d = JSON.parse(text); } catch {}
  return { status: r.status, d, text };
}

const room = (kind, base) => call({ action: 'create', ...(kind ? { kind } : {}) }, base).then((r) => r.d);
const join = (code, base) => call({ action: 'join', code }, base).then((r) => r.d);
const ice = (code, peer, token, base) => call({ action: 'ice', code, peer, token }, base);

async function stub(mode) {
  const r = await fetch(`${STUB}/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  assert.equal(r.status, 200);
}
const stubStats = () => fetch(`${STUB}/stats`).then((r) => r.json());

const urlsOf = (servers) => servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
function assertStunOnly(r, why) {
  assert.equal(r.status, 200, `${why}: status`);
  assert.equal(r.d.relay, false, `${why}: relay flag`);
  assert.deepEqual(urlsOf(r.d.iceServers), STUN, `${why}: STUN only`);
}
function assertRelay(r, why) {
  assert.equal(r.status, 200, `${why}: status`);
  assert.equal(r.d.relay, true, `${why}: relay flag`);
  const s = r.d.iceServers;
  assert.deepEqual(urlsOf(s.slice(0, 2)), STUN, `${why}: STUN entries first`);
  const turn = s.slice(2);
  assert.equal(turn.length, 1, `${why}: one TURN entry`);
  assert.ok(turn[0].urls.every((u) => /^turns?:/.test(u)), `${why}: TURN urls only`);
  assert.ok(turn[0].urls.includes('turns:turn.cloudflare.com:443?transport=tcp'));
  assert.ok(!turn[0].urls.some((u) => /:53(\?|$)/.test(u)), `${why}: port 53 dropped`);
  assert.equal(turn[0].urls.length, 6, `${why}: the six documented TURN urls`);
  assert.equal(turn[0].username, 'stub-user-0123456789abcdef');
  assert.equal(turn[0].credential, 'stub-cred-fedcba9876543210');
  assert.ok(r.d.ttl > 0 && r.d.ttl <= 3600, `${why}: ttl ${r.d.ttl}`);
}

test('ice: missing, wrong or another peer\'s token is 401', async () => {
  const h = await room();
  const g = await join(h.code);
  assert.equal((await ice(h.code, 'h')).status, 401, 'no token');
  assert.equal((await ice(h.code, 'h', 'WRONG')).status, 401, 'wrong token');
  assert.equal((await ice(h.code, 'h', g.token)).status, 401, 'guest token for host');
  assert.equal((await ice(h.code, g.peer, h.token)).status, 401, 'host token for guest');
  assert.equal((await call({ action: 'ice', code: h.code, token: h.token })).status, 400, 'no peer id');
});

test('ice: unknown or ended session is 404', async () => {
  assert.equal((await ice('ZZZZZ2', 'h', 'x')).status, 404, 'unknown code');
  const h = await room();
  const g = await join(h.code);
  assert.equal((await call({ action: 'end', code: h.code, peer: 'h', token: h.token })).status, 200);
  assert.equal((await ice(h.code, 'h', h.token)).status, 404, 'host after end');
  assert.equal((await ice(h.code, g.peer, g.token)).status, 404, 'guest after end');
});

test('ice: a joined peer gets STUN first, then TURN credentials from the stub', { skip: needStub }, async () => {
  await stub('ok');
  const h = await room();
  const g = await join(h.code);
  assertRelay(await ice(h.code, g.peer, g.token), 'guest');
  const st = await stubStats();
  assert.equal(st.last.method, 'POST');
  assert.equal(st.last.authOk, true, 'Bearer token sent');
  assert.equal(st.last.contentType, 'application/json');
  assert.ok(st.last.ttl > 0 && st.last.ttl <= 3600, `requested ttl ${st.last.ttl}`);
  assertRelay(await ice(h.code, 'h', h.token), 'host');
  const c = await room('c');
  assertRelay(await ice(c.code, 'h', c.token), 'chat host');
});

test('ice: kill switch (BEAM_TURN_ENABLED=0) gives STUN only', { skip: !OFF_BASE && 'set BEAM_TURN_OFF_BASE' }, async () => {
  const h = await room(undefined, OFF_BASE);
  const g = await join(h.code, OFF_BASE);
  const before = STUB ? (await stubStats()).count : 0;
  assertStunOnly(await ice(h.code, g.peer, g.token, OFF_BASE), 'kill switch');
  assertStunOnly(await ice(h.code, 'h', h.token, OFF_BASE), 'kill switch host');
  if (STUB) assert.equal((await stubStats()).count, before, 'no call to Cloudflare');
});

test('ice: empty key id / blank token (compose env_file unset) gives STUN only, no call out', { skip: !EMPTY_BASE && 'set BEAM_TURN_EMPTY_BASE' }, async () => {
  const h = await room(undefined, EMPTY_BASE);
  const g = await join(h.code, EMPTY_BASE);
  const before = STUB ? (await stubStats()).count : 0;
  assertStunOnly(await ice(h.code, g.peer, g.token, EMPTY_BASE), 'empty key id');
  assertStunOnly(await ice(h.code, 'h', h.token, EMPTY_BASE), 'empty key id host');
  if (STUB) assert.equal((await stubStats()).count, before, 'no call to Cloudflare');
});

test('ice: Cloudflare down, failing, garbled or slow gives STUN only with 200', { skip: needStub, timeout: 60000 }, async () => {
  try {
    for (const mode of ['down', 'error', 'garbage', 'slow']) {
      await stub(mode);
      const h = await room();
      const t0 = Date.now();
      const r = await ice(h.code, 'h', h.token);
      assertStunOnly(r, `stub ${mode}`);
      assert.ok(Date.now() - t0 < 7000, `stub ${mode}: answered in ${Date.now() - t0} ms`);
    }
  } finally {
    await stub('ok');
  }
});

test('ice: at most one mint per peer per 30 s', { skip: needStub }, async () => {
  await stub('ok');
  const h = await room();
  const before = (await stubStats()).count;
  assertRelay(await ice(h.code, 'h', h.token), 'first');
  assertStunOnly(await ice(h.code, 'h', h.token), 'second, within 30 s');
  assert.equal((await stubStats()).count, before + 1, 'one call to Cloudflare');
  // another peer in the same session has its own window
  const g = await join(h.code);
  assertRelay(await ice(h.code, g.peer, g.token), 'other peer');
});

test('ice: at most 20 mints per beam session', { skip: needStub, timeout: 120000 }, async () => {
  // 9 devices (host + 8 guests) x 3 rounds 31 s apart = 27 asks; only 20 may mint.
  await stub('ok');
  const h = await room();
  const peers = [{ peer: 'h', token: h.token }];
  for (let i = 0; i < 8; i++) {
    const g = await join(h.code);
    peers.push({ peer: g.peer, token: g.token });
  }
  let relayed = 0, stunOnly = 0;
  for (let round = 0; round < 3; round++) {
    if (round) await new Promise((r) => setTimeout(r, 31000));
    for (const p of peers) {
      const r = await ice(h.code, p.peer, p.token);
      assert.equal(r.status, 200);
      if (r.d.relay) relayed++; else stunOnly++;
    }
  }
  assert.equal(relayed, 20, 'session budget');
  assert.equal(stunOnly, 7);
});

test('the TURN API token never appears in a response, the logs or the data dir', { skip: !TOKEN && 'set BEAM_TURN_API_TOKEN' }, async () => {
  assert.ok(bodies.length > 0, 'saw responses');
  for (const b of bodies) assert.ok(!b.includes(TOKEN), 'token in a response body');
  if (C) {
    const logs = spawnSync('docker', ['logs', C], { encoding: 'utf8' });
    assert.ok(!(logs.stdout + logs.stderr).includes(TOKEN), 'token in container logs');
    const grep = spawnSync('docker', ['exec', C, 'grep', '-r', '-a', '-c', '-F', TOKEN, '/var/www/beam/beamtm_data'], { encoding: 'utf8' });
    assert.ok(!/:[1-9]/.test(grep.stdout), `token in the data dir: ${grep.stdout}`);
  }
});
