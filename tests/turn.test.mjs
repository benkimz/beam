// TURN relay credentials (beam.php action "ice"). The main instance (BEAM_BASE) must
// run with
//   BEAM_TURN_ENABLED=1 BEAM_TURN_KEY_ID=<id> BEAM_TURN_API_TOKEN=<token>
//   BEAM_TURN_API_BASE=http://<stub host>:8787/v1 BEAM_TRUST_PROXY_IP=1
// (so each test can act as many clients through X-Forwarded-For), with the stub
// (tests/turn-stub.mjs) running. Set in the test environment:
//   BEAM_TURN_STUB          the stub's control URL (e.g. http://127.0.0.1:8788)
//   BEAM_TURN_KEY_ID        the main instance's key id
//   BEAM_TURN_API_TOKEN     the same token, so we can check it never leaks
// and, optionally, further instances:
//   BEAM_TURN_NOTRUST_BASE  TURN on, stub, BEAM_TRUST_PROXY_IP unset, BEAM_TURN_DEBUG=1,
//                           and a different BEAM_TURN_KEY_ID
//   BEAM_TURN_OFF_BASE      BEAM_TURN_ENABLED=0
//   BEAM_TURN_EMPTY_BASE    BEAM_TURN_ENABLED=1 but empty key id and blank token (as
//                           compose env_file passes unset values), API base on the stub
//   BEAM_TURN_BADBASE_BASE  TURN on, BEAM_TURN_API_BASE=http://<non-local name for the stub>
//   BEAM_CONTAINER          container name, to check logs and the data dir
// The auth tests also run against any beam without TURN configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { BASE, PROXY_HEADERS } from './helpers.mjs';

const STUB = process.env.BEAM_TURN_STUB;
const TOKEN = process.env.BEAM_TURN_API_TOKEN;
const KEY = process.env.BEAM_TURN_KEY_ID;
const NOTRUST = process.env.BEAM_TURN_NOTRUST_BASE;
const OFF_BASE = process.env.BEAM_TURN_OFF_BASE;
const EMPTY_BASE = process.env.BEAM_TURN_EMPTY_BASE;
const BADBASE = process.env.BEAM_TURN_BADBASE_BASE;
const C = process.env.BEAM_CONTAINER;
const needStub = !STUB && 'set BEAM_TURN_STUB (and run beam against tests/turn-stub.mjs) for TURN tests';
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const bodies = []; // every raw response body, checked for the API token at the end
const used = new Set();
// A fresh client address, unique within the run.
function freshIp() {
  for (;;) {
    const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
    if (!used.has(ip)) { used.add(ip); return ip; }
  }
}

async function call(payload, { base = BASE, ip } = {}) {
  const r = await fetch(`${base}/api/beam.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PROXY_HEADERS, ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  bodies.push(text);
  let d = {};
  try { d = JSON.parse(text); } catch {}
  return { status: r.status, d, text };
}

const room = (kind, base = BASE) => call({ action: 'create', ...(kind ? { kind } : {}) }, { base }).then((r) => r.d);
const join = (code, base = BASE) => call({ action: 'join', code }, { base }).then((r) => r.d);
// Every mint comes from its own client address unless a test says otherwise.
const ice = (code, peer, token, opts = {}) =>
  call({ action: 'ice', code, peer, token }, { ip: opts.ip === undefined ? freshIp() : opts.ip, base: opts.base });
const end = (r) => call({ action: 'end', code: r.code, peer: 'h', token: r.token });

async function stub(mode) {
  const r = await fetch(`${STUB}/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  assert.equal(r.status, 200);
}
const stubStats = () => fetch(`${STUB}/stats`).then((r) => r.json());
// The stub may have served earlier runs: count this run's mints from here.
const okAtStart = STUB ? (await stubStats()).okByKey : {};

async function roomWithGuests(n, kind, base = BASE) {
  const h = await room(kind, base);
  const peers = [{ peer: 'h', token: h.token }];
  for (let i = 0; i < n; i++) {
    const g = await join(h.code, base);
    peers.push({ peer: g.peer, token: g.token });
  }
  return { h, peers };
}

const urlsOf = (servers) => servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
function assertStunOnly(r, why) {
  assert.equal(r.status, 200, `${why}: status`);
  assert.equal(r.d.relay, false, `${why}: relay flag`);
  assert.deepEqual(urlsOf(r.d.iceServers), STUN, `${why}: STUN only`);
}
function assertRelay(r, why, ttl = 1200) {
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
  assert.match(turn[0].username, /^stub-user-\d+$/);
  assert.equal(turn[0].credential, 'stub-cred-fedcba9876543210');
  assert.equal(r.d.ttl, ttl, `${why}: ttl`);
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
  assert.equal((await end(h)).status, 200);
  assert.equal((await ice(h.code, 'h', h.token)).status, 404, 'host after end');
  assert.equal((await ice(h.code, g.peer, g.token)).status, 404, 'guest after end');
});

test('ice: a joined peer gets STUN first, then TURN; beams ask for 1200 s, chats 3600 s', { skip: needStub }, async () => {
  await stub('ok');
  const h = await room();
  const g = await join(h.code);
  const r = await ice(h.code, g.peer, g.token);
  assertRelay(r, 'guest', 1200);
  assert.equal(r.d.debug, false, 'debug off unless BEAM_TURN_DEBUG=1');
  const st = await stubStats();
  assert.equal(st.last.method, 'POST');
  assert.equal(st.last.authOk, true, 'Bearer token sent');
  assert.equal(st.last.contentType, 'application/json');
  assert.equal(st.last.ttl, 1200, 'beam credentials requested for 1200 s');
  assertRelay(await ice(h.code, 'h', h.token), 'host', 1200);
  const c = await room('c');
  assertRelay(await ice(c.code, 'h', c.token), 'chat host', 3600);
  assert.equal((await stubStats()).last.ttl, 3600, 'chat credentials requested for 3600 s');
});

for (const [name, base, why] of [
  ['kill switch (BEAM_TURN_ENABLED=0)', OFF_BASE, 'BEAM_TURN_OFF_BASE'],
  ['empty key id / blank token (compose env_file unset)', EMPTY_BASE, 'BEAM_TURN_EMPTY_BASE'],
  ['a plain-http, non-local BEAM_TURN_API_BASE (https guard)', BADBASE, 'BEAM_TURN_BADBASE_BASE'],
]) {
  test(`ice: ${name} gives STUN only, no call out`, { skip: !base && `set ${why}` }, async () => {
    const { h, peers } = await roomWithGuests(1, undefined, base);
    const before = STUB ? (await stubStats()).count : 0;
    assertStunOnly(await ice(h.code, peers[1].peer, peers[1].token, { base }), `${name}: guest`);
    assertStunOnly(await ice(h.code, 'h', h.token, { base }), `${name}: host`);
    if (STUB) assert.equal((await stubStats()).count, before, 'no call to the API');
  });
}

test('ice: Cloudflare down, failing, garbled or slow gives STUN only with 200, fast', { skip: needStub, timeout: 60000 }, async () => {
  try {
    for (const mode of ['down', 'error', 'garbage', 'slow']) {
      await stub(mode);
      const h = await room();
      const t0 = Date.now();
      const r = await ice(h.code, 'h', h.token);
      const ms = Date.now() - t0;
      assertStunOnly(r, `stub ${mode}`);
      assert.ok(ms < 2500, `stub ${mode}: answered in ${ms} ms (server gives up before the client's 2 s)`);
    }
  } finally {
    await stub('ok');
  }
});

test('ice: failed mints are not counted (the IP budget is refunded)', { skip: needStub }, async () => {
  const ip = freshIp();
  const { h, peers } = await roomWithGuests(7);
  try {
    await stub('error');
    for (const p of peers.slice(0, 7)) assertStunOnly(await ice(h.code, p.peer, p.token, { ip }), 'failing');
  } finally {
    await stub('ok');
  }
  // 7 failures from one IP; had they counted, the 6-per-10-min budget would be gone
  assertRelay(await ice(h.code, peers[7].peer, peers[7].token, { ip }), 'first real mint from that IP');
});

test('ice: at most one mint per peer per 30 s', { skip: needStub }, async () => {
  await stub('ok');
  const h = await room();
  const before = (await stubStats()).count;
  assertRelay(await ice(h.code, 'h', h.token), 'first');
  assertStunOnly(await ice(h.code, 'h', h.token), 'second, within 30 s');
  assert.equal((await stubStats()).count, before + 1, 'one call to Cloudflare');
  const g = await join(h.code);
  assertRelay(await ice(h.code, g.peer, g.token), 'other peer');
});

test('ice: at most 6 mints per client IP per 10 min (X-Forwarded-For trusted)', { skip: needStub }, async () => {
  await stub('ok');
  const ip = freshIp();
  const { h, peers } = await roomWithGuests(8);
  for (let i = 0; i < 6; i++) {
    // only the first X-Forwarded-For value is the client
    const xff = i % 2 ? `${ip}, ${freshIp()}` : ip;
    assertRelay(await ice(h.code, peers[i].peer, peers[i].token, { ip: xff }), `mint ${i + 1} from one IP`);
  }
  assertStunOnly(await ice(h.code, peers[6].peer, peers[6].token, { ip }), '7th from the same IP');
  assertStunOnly(await ice(h.code, peers[7].peer, peers[7].token, { ip: `${ip}, 10.9.9.9` }), 'same IP, other proxies after it');
  assertRelay(await ice(h.code, peers[8].peer, peers[8].token), 'another IP is unaffected');
});

// A fresh IPv6 /64 (documentation range), unique within the run.
function freshV6Prefix() {
  for (;;) {
    const p = `2001:db8:${randomInt(1, 65536).toString(16)}:${randomInt(1, 65536).toString(16)}`;
    if (!used.has(p)) { used.add(p); return p; }
  }
}

// Six mints from the `first` addresses, then a seventh from `last` must be refused.
async function assertSharedBudget(first, last, why) {
  const { h, peers } = await roomWithGuests(7);
  for (let i = 0; i < 6; i++) {
    assertRelay(await ice(h.code, peers[i].peer, peers[i].token, { ip: first[i] }), `${why}: mint ${i + 1} (${first[i]})`);
  }
  assertStunOnly(await ice(h.code, peers[6].peer, peers[6].token, { ip: last }), `${why}: 7th (${last}) shares the budget`);
}

test('ice: the per-IP budget is per IPv6 /64', { skip: needStub }, async () => {
  await stub('ok');
  const p = freshV6Prefix();
  await assertSharedBudget([1, 2, 3, 0xabc, 0xffff, 9].map((n) => `${p}:${n.toString(16)}::1`), `${p}:dead:beef:1:2`, 'one /64');
  // the neighbouring /64 is a different client
  const { h, peers } = await roomWithGuests(0);
  assertRelay(await ice(h.code, peers[0].peer, peers[0].token, { ip: `${freshV6Prefix()}::1` }), 'another /64');
});

test('ice: text forms of one address share a key; IPv4-mapped IPv6 equals IPv4', { skip: needStub }, async () => {
  await stub('ok');
  const p = freshV6Prefix();
  const [, , a, b] = p.split(':');
  const forms = [`${p}::1`, `2001:0db8:${a.padStart(4, '0')}:${b.padStart(4, '0')}:0:0:0:1`,
    `2001:DB8:${a.toUpperCase()}:${b.toUpperCase()}::1`, `${p}:0::1`, `${p}:0:0:0:1`, `${p}::0:1`];
  await assertSharedBudget(forms, `${p}::0001`, 'one IPv6 address, many spellings');
  const v4 = freshIp();
  await assertSharedBudget([v4, `::ffff:${v4}`, v4, `::FFFF:${v4}`, `0:0:0:0:0:ffff:${v4}`, v4], `::ffff:${v4}`, 'IPv4 and IPv4-mapped');
});

test('ice: without BEAM_TRUST_PROXY_IP a spoofed X-Forwarded-For is ignored; debug flag', { skip: needStub || (!NOTRUST && 'set BEAM_TURN_NOTRUST_BASE') }, async () => {
  await stub('ok');
  const { h, peers } = await roomWithGuests(7, undefined, NOTRUST);
  for (let i = 0; i < 6; i++) {
    const r = await ice(h.code, peers[i].peer, peers[i].token, { base: NOTRUST, ip: freshIp() });
    assertRelay(r, `mint ${i + 1}, spoofed XFF`);
    assert.equal(r.d.debug, true, 'BEAM_TURN_DEBUG=1 is reported to the client');
  }
  // every request came from the same REMOTE_ADDR, whatever the header said
  const r = await ice(h.code, peers[6].peer, peers[6].token, { base: NOTRUST, ip: freshIp() });
  assertStunOnly(r, '7th: XFF spoof did not dodge the per-IP limit');
  assert.equal(r.d.debug, true);
});

test('ice: at most 20 mints per beam session', { skip: needStub, timeout: 120000 }, async () => {
  // 9 devices (host + 8 guests) x 3 rounds 31 s apart = 27 asks; only 20 may mint.
  await stub('ok');
  const { h, peers } = await roomWithGuests(8);
  for (const p of peers) p.ip = freshIp(); // 3 asks per IP: under the per-IP limit
  let relayed = 0, stunOnly = 0;
  for (let round = 0; round < 3; round++) {
    if (round) await new Promise((r) => setTimeout(r, 31000));
    for (const p of peers) {
      const r = await ice(h.code, p.peer, p.token, { ip: p.ip });
      assert.equal(r.status, 200);
      if (r.d.relay) relayed++; else stunOnly++;
    }
  }
  assert.equal(relayed, 20, 'session budget');
  assert.equal(stunOnly, 7);
});

test('end revokes the session\'s TURN credentials; a failing revoke never affects end', { skip: needStub }, async () => {
  await stub('ok');
  const { h, peers } = await roomWithGuests(2);
  const names = [];
  for (const p of peers) {
    const r = await ice(h.code, p.peer, p.token);
    assertRelay(r, p.peer);
    names.push(r.d.iceServers[2].username);
  }
  const t0 = Date.now();
  assert.equal((await end(h)).status, 200);
  assert.ok(Date.now() - t0 < 2500, 'end stays fast');
  const st = await stubStats();
  for (const n of names) assert.ok(st.revoked.includes(n), `revoked ${n}`);
  // Cloudflare down at end time: end still succeeds, quickly
  const b = await roomWithGuests(0);
  assertRelay(await ice(b.h.code, 'h', b.h.token), 'second room');
  try {
    await stub('down');
    const t1 = Date.now();
    assert.equal((await end(b.h)).status, 200);
    assert.ok(Date.now() - t1 < 2500, `end with Cloudflare down took ${Date.now() - t1} ms`);
  } finally {
    await stub('ok');
  }
  // a room without TURN credentials ends without calling out
  const before = (await stubStats()).revoked.length;
  const c = await room();
  assert.equal((await end(c)).status, 200);
  assert.equal((await stubStats()).revoked.length, before);
});

// Runs last among the minting tests: it uses up the site-wide daily budget.
test('ice: the site-wide daily cap (1000) holds under concurrency, then nothing calls out', { skip: needStub || (!KEY && 'set BEAM_TURN_KEY_ID'), timeout: 600000 }, async () => {
  await stub('ok');
  let capped = false;
  for (let rooms = 0; rooms < 200 && !capped; rooms++) {
    const { h, peers } = await roomWithGuests(8);
    // all nine devices ask at once, each from its own address
    const rs = await Promise.all(peers.map((p) => ice(h.code, p.peer, p.token)));
    for (const r of rs) {
      assert.equal(r.status, 200);
      // a fresh peer on a fresh IP in a fresh room is refused only by the daily cap
      if (!r.d.relay) capped = true;
    }
  }
  assert.ok(capped, 'reached the daily cap');
  const st = await stubStats();
  const minted = (k) => (st.okByKey[k] || 0) - (okAtStart[k] || 0);
  const mine = minted(KEY);
  const all = Object.keys(st.okByKey).reduce((a, k) => a + minted(k), 0);
  // This instance minted at most 1000; if instances share one database, all of them
  // together reached the cap.
  assert.ok(mine <= 1000, `minted ${mine} > 1000`);
  assert.ok(all >= 1000, `cap reached after only ${all} mints`);
  const { h, peers } = await roomWithGuests(4);
  for (const p of peers) assertStunOnly(await ice(h.code, p.peer, p.token), 'capped');
  assert.equal((await stubStats()).count, st.count, 'no call out once capped');
});

test('the TURN API token never appears in a response, the logs or the data dir', { skip: !TOKEN && 'set BEAM_TURN_API_TOKEN' }, async () => {
  assert.ok(bodies.length > 0, 'saw responses');
  for (const b of bodies) assert.ok(!b.includes(TOKEN), 'token in a response body');
  if (C) {
    const logs = spawnSync('docker', ['logs', C], { encoding: 'utf8' });
    assert.ok(!(logs.stdout + logs.stderr).includes(TOKEN), 'token in container logs');
    const grep = spawnSync('docker', ['exec', C, 'grep', '-r', '-a', '-c', '-F', TOKEN, '/var/www/beam/beamtm_data'], { encoding: 'utf8' });
    assert.ok(!/:[1-9]/.test(grep.stdout), `token in the data dir: ${grep.stdout}`);
    // per-IP counters hold HMACs only: none of the client addresses used is stored
    const dump = spawnSync('docker', ['exec', C, 'sh', '-c', 'cat /var/www/beam/beamtm_data/beam.db*'],
      { encoding: 'latin1', maxBuffer: 1 << 28 });
    assert.ok(dump.stdout.length > 0, 'read the database');
    for (const ip of [...used].slice(0, 200)) assert.ok(!dump.stdout.includes(ip), `raw IP ${ip} stored`);
  }
});
