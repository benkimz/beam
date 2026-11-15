// Unit tests for assets/ice.js (the client's ICE server merge and fallback). No server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { setTimeout, clearTimeout, Promise };
vm.runInNewContext(readFileSync('assets/ice.js', 'utf8'), ctx);
const { BeamIce } = ctx;
const plain = (o) => JSON.parse(JSON.stringify(o)); // across the vm realm boundary
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const TURN = { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'u', credential: 'c' };

test('a server answer with TURN keeps STUN first and the TURN entry after', () => {
  const r = BeamIce.normalize({ iceServers: [TURN, ...STUN], ttl: 3600, relay: true });
  assert.deepEqual(plain(r.iceServers), [...STUN, TURN]);
  assert.equal(r.relay, true);
  assert.equal(r.cacheMs, (3600 - 300) * 1000, 'refresh 5 min before expiry');
});

test('missing, malformed or STUN-only answers fall back to the built-in STUN list', () => {
  for (const bad of [null, undefined, {}, { iceServers: 'x' }, { iceServers: [] }, { iceServers: [{ urls: 'http://evil' }] }]) {
    const r = BeamIce.normalize(bad);
    assert.deepEqual(plain(r.iceServers), STUN);
    assert.equal(r.relay, false);
    assert.equal(r.cacheMs, BeamIce.FALLBACK_CACHE_MS);
  }
  const stunOnly = BeamIce.normalize({ iceServers: STUN, ttl: 0, relay: false });
  assert.deepEqual(plain(stunOnly.iceServers), STUN);
  assert.equal(stunOnly.relay, false);
});

test('TURN entries without a username and credential are dropped', () => {
  const r = BeamIce.normalize({ iceServers: [...STUN, { urls: TURN.urls }], ttl: 3600 });
  assert.deepEqual(plain(r.iceServers), STUN);
  assert.equal(r.relay, false);
});

test('load() falls back to STUN on rejection and on a slow answer', async () => {
  const rejected = await BeamIce.load(() => Promise.reject(new Error('500')), 2000);
  assert.deepEqual(plain(rejected.iceServers), STUN);
  const thrown = await BeamIce.load(() => { throw new Error('sync'); }, 2000);
  assert.equal(thrown.relay, false);
  const t0 = Date.now();
  const slow = await BeamIce.load(() => new Promise((r) => setTimeout(() => r({ iceServers: [...STUN, TURN], ttl: 3600 }), 1000)), 50);
  assert.ok(Date.now() - t0 < 900, 'did not wait for the slow answer');
  assert.equal(slow.relay, false);
  const ok = await BeamIce.load(() => Promise.resolve({ iceServers: [...STUN, TURN], ttl: 3600 }), 2000);
  assert.equal(ok.relay, true);
});

test('rtcConfig forces relay only when asked, a relay was offered and the server allows debug', () => {
  const relayDebug = BeamIce.normalize({ iceServers: [...STUN, TURN], ttl: 3600, debug: true });
  const relayNoDebug = BeamIce.normalize({ iceServers: [...STUN, TURN], ttl: 3600, debug: false });
  const none = BeamIce.normalize({ iceServers: STUN, ttl: 0, debug: true });
  assert.equal(BeamIce.rtcConfig(relayDebug, false).iceTransportPolicy, undefined);
  assert.equal(BeamIce.rtcConfig(relayDebug, true).iceTransportPolicy, 'relay');
  assert.equal(BeamIce.rtcConfig(relayNoDebug, true).iceTransportPolicy, undefined, '?relay=1 ignored without server debug');
  assert.equal(BeamIce.rtcConfig(none, true).iceTransportPolicy, undefined, '?relay=1 ignored without TURN');
  assert.equal(BeamIce.normalize({ iceServers: [...STUN, TURN], ttl: 3600, debug: 'yes' }).debug, false, 'debug must be true');
});

test('port-53 URLs are dropped on the client too', () => {
  const r = BeamIce.normalize({ iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    { urls: ['turn:t.example:53?transport=udp', 'turns:t.example:5349?transport=tcp'], username: 'u', credential: 'c' },
    { urls: 'turn:t.example:53', username: 'u', credential: 'c' },
  ], ttl: 1200 });
  assert.deepEqual(plain(r.iceServers), [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turns:t.example:5349?transport=tcp'], username: 'u', credential: 'c' },
  ]);
  assert.equal(r.cacheMs, (1200 - 300) * 1000, 'beam credentials (1200 s) refresh at 15 min');
});

test('refresh trigger: next refresh at the credentials\' cache time, failures back off and never stop', () => {
  const ok = BeamIce.normalize({ iceServers: [...STUN, TURN], ttl: 3600 });
  assert.equal(BeamIce.refreshDelay(ok, 0), 3300000, '55 min for 1 h credentials');
  assert.equal(BeamIce.refreshDelay(ok, 7), 3300000, 'a success resets the backoff');
  const fail = BeamIce.stunOnly();
  const delays = [0, 1, 2, 3, 4, 5, 20].map((a) => BeamIce.refreshDelay(fail, a));
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000, 300000]);
  assert.ok(delays.every((d) => Number.isFinite(d) && d > 0), 'always schedules another try');
});

test('selectedPath reads the selected candidate pair from getStats values', () => {
  const stats = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
    { id: 'P1', type: 'candidate-pair', state: 'failed', localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L2', remoteCandidateId: 'R1' },
    { id: 'L1', type: 'local-candidate', candidateType: 'host' },
    { id: 'L2', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' },
  ];
  assert.deepEqual(plain(BeamIce.selectedPath(stats)), { local: 'relay', remote: 'srflx' });
  assert.equal(BeamIce.isRelayed(BeamIce.selectedPath(stats)), true);
  // Firefox style: no transport stats, a selected pair instead
  const ff = stats.filter((s) => s.type !== 'transport').map((s) => (s.id === 'P1' ? { ...s, state: 'succeeded', selected: true } : s));
  assert.deepEqual(plain(BeamIce.selectedPath(ff)), { local: 'host', remote: 'srflx' });
  assert.equal(BeamIce.isRelayed(BeamIce.selectedPath(ff)), false);
  assert.equal(BeamIce.selectedPath([]), null);
  assert.equal(BeamIce.isRelayed(null), false);
});

test('refreshPlan: relayed guests ICE-restart, the host asks relayed guests to, others just reconfigure', () => {
  const peers = [
    { id: 'gAAAA', path: { local: 'relay', remote: 'host' } },
    { id: 'gBBBB', path: { local: 'srflx', remote: 'relay' } },
    { id: 'gCCCC', path: null },
  ];
  assert.deepEqual(plain(BeamIce.refreshPlan(true, peers)), [
    { id: 'gAAAA', action: 'ask' }, { id: 'gBBBB', action: 'config' }, { id: 'gCCCC', action: 'config' }]);
  assert.deepEqual(plain(BeamIce.refreshPlan(false, [{ id: 'h', path: { local: 'relay', remote: 'srflx' } }])),
    [{ id: 'h', action: 'restart' }]);
  assert.deepEqual(plain(BeamIce.refreshPlan(false, [{ id: 'h', path: { local: 'host', remote: 'relay' } }])),
    [{ id: 'h', action: 'config' }]);
});
