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

test('rtcConfig forces relay only when asked and a relay was offered', () => {
  const relay = BeamIce.normalize({ iceServers: [...STUN, TURN], ttl: 3600 });
  const none = BeamIce.stunOnly();
  assert.equal(BeamIce.rtcConfig(relay, false).iceTransportPolicy, undefined);
  assert.equal(BeamIce.rtcConfig(relay, true).iceTransportPolicy, 'relay');
  assert.equal(BeamIce.rtcConfig(none, true).iceTransportPolicy, undefined, 'stray ?relay=1 without TURN is ignored');
});
