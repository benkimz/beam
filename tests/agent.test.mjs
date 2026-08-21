// Agent bus (api/agent.php) — durable authenticated rooms, roster, broadcast, observers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, b64, unb64 } from './helpers.mjs';

async function room(observable = true) {
  const { d } = await api('agent.php', { action: 'create', ttl: 3600, observable });
  return d;
}

test('create returns code, token, observer code, expiry', async () => {
  const r = await room(true);
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  assert.ok(r.token && r.observerCode);
  assert.ok(r.expires_in > 0 && r.maxGuests === 8);
});

test('directed + broadcast delivery, sender-exclusion, roster', async () => {
  const r = await room();
  const a = (await api('agent.php', { action: 'join', code: r.code })).d;
  const b = (await api('agent.php', { action: 'join', code: r.code })).d;

  await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: a.token, to: b.peer, body: b64('for-b') });
  const bp = await api('agent.php', { action: 'poll', code: r.code, peer: b.peer, token: b.token, after: 0 });
  assert.equal(bp.d.msgs.length, 1);
  assert.equal(unb64(bp.d.msgs[0].body), 'for-b');
  assert.ok(bp.d.peers.length >= 3, 'poll returns the roster');

  const ap = await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, token: a.token, after: 0 });
  assert.equal(ap.d.msgs.length, 0, 'sender does not receive its own directed message');

  await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: a.token, to: 'room', body: b64('all') });
  const bp2 = await api('agent.php', { action: 'poll', code: r.code, peer: b.peer, token: b.token, after: bp.d.msgs[0].id });
  assert.ok(bp2.d.msgs.some((m) => unb64(m.body) === 'all'), 'broadcast reaches other members');
  const ap2 = await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, token: a.token, after: 0 });
  assert.ok(!ap2.d.msgs.some((m) => unb64(m.body) === 'all'), 'broadcaster excluded from its own broadcast');
});

test('observers see everything, cannot send, cannot be addressed', async () => {
  const r = await room(true);
  const a = (await api('agent.php', { action: 'join', code: r.code })).d;
  const o = (await api('agent.php', { action: 'join', code: r.observerCode })).d;
  assert.equal(o.role, 'observer');

  await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: a.token, to: 'room', body: b64('hi') });
  const op = await api('agent.php', { action: 'poll', code: r.observerCode, peer: o.peer, token: o.token, after: 0 });
  assert.ok(op.d.msgs.length >= 1, 'observer sees the conversation');

  assert.equal((await api('agent.php', { action: 'signal', code: r.observerCode, peer: o.peer, token: o.token, to: 'room', body: b64('x') })).status, 403, 'observer cannot send');
  assert.equal((await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: a.token, to: o.peer, body: b64('x') })).status, 400, 'observer is not an addressable target');
});

test('ADVERSARIAL: token auth defends inbox and sender', async () => {
  const r = await room();
  const a = (await api('agent.php', { action: 'join', code: r.code })).d;
  assert.equal((await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, after: 0 })).status, 401, 'no token');
  assert.equal((await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, token: 'WRONG', after: 0 })).status, 401, 'wrong token');
  assert.equal((await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: r.token, to: 'room', body: b64('x') })).status, 401, 'host token cannot act as member');
});

test('ADVERSARIAL: distinct error codes', async () => {
  const r = await room();
  const a = (await api('agent.php', { action: 'join', code: r.code })).d;
  assert.equal((await api('agent.php', { action: 'signal', code: r.code, peer: 'BAD!!', token: a.token, to: 'room', body: 'x' })).status, 400, 'malformed');
  assert.equal((await api('agent.php', { action: 'signal', code: r.code, peer: a.peer, token: a.token, to: 'gZZZZ', body: b64('x') })).status, 404, 'unknown_peer');
  assert.equal((await api('agent.php', { action: 'poll', code: 'ZZZZZZ', peer: 'h', token: 'x', after: 0 })).status, 404, 'unknown_room');
  assert.equal((await api('agent.php', { action: 'end', code: r.code, peer: a.peer, token: a.token })).status, 403, 'member cannot end');
});

test('host initiates via roster, then ends the room', async () => {
  const r = await room();
  const a = (await api('agent.php', { action: 'join', code: r.code })).d;
  const hp = await api('agent.php', { action: 'poll', code: r.code, peer: 'h', token: r.token, after: 0 });
  assert.ok(hp.d.peers.some((p) => p.peer === a.peer), 'host sees the member in the roster');
  await api('agent.php', { action: 'signal', code: r.code, peer: 'h', token: r.token, to: a.peer, body: b64('hello') });
  const ap = await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, token: a.token, after: 0 });
  assert.ok(ap.d.msgs.some((m) => unb64(m.body) === 'hello'));
  assert.equal((await api('agent.php', { action: 'end', code: r.code, peer: 'h', token: r.token })).status, 200);
  assert.equal((await api('agent.php', { action: 'poll', code: r.code, peer: a.peer, token: a.token, after: 0 })).status, 404, 'ended room is gone');
});
