// Classic beam/chat rooms (api/beam.php) — per-peer token auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE, PROXY_HEADERS } from './helpers.mjs';

test('create issues a room code and a host token', async () => {
  const { status, d } = await api('beam.php', { action: 'create' });
  assert.equal(status, 200);
  assert.match(d.code, /^[A-Z2-9]{6}$/);
  assert.ok(d.token, 'create must return a token');
});

test('join issues a peer id and a token', async () => {
  const { d: room } = await api('beam.php', { action: 'create' });
  const { status, d } = await api('beam.php', { action: 'join', code: room.code });
  assert.equal(status, 200);
  assert.match(d.peer, /^g[A-Z2-9]{4}$/);
  assert.ok(d.token);
});

test('authenticated signal is attributed to the token holder, and poll delivers it', async () => {
  const { d: room } = await api('beam.php', { action: 'create' });
  const { d: guest } = await api('beam.php', { action: 'join', code: room.code });
  const sig = await api('beam.php', { action: 'signal', code: room.code, peer: guest.peer, token: guest.token, to: 'h', body: '{"t":"offer"}' });
  assert.equal(sig.status, 200);
  const poll = await api('beam.php', { action: 'poll', code: room.code, peer: 'h', token: room.token, after: 0 });
  assert.equal(poll.status, 200);
  assert.equal(poll.d.msgs.length, 1);
  assert.equal(poll.d.msgs[0].sender, guest.peer, 'sender is the authenticated peer, not a client field');
});

test('ADVERSARIAL: knowing the code does not let you read a peer inbox or impersonate', async () => {
  const { d: room } = await api('beam.php', { action: 'create' });
  const { d: guest } = await api('beam.php', { action: 'join', code: room.code });

  // inbox theft: poll as a peer without their token
  assert.equal((await api('beam.php', { action: 'poll', code: room.code, peer: 'h', after: 0 })).status, 401, 'poll without token');
  assert.equal((await api('beam.php', { action: 'poll', code: room.code, peer: guest.peer, token: 'WRONG', after: 0 })).status, 401, 'wrong token');
  assert.equal((await api('beam.php', { action: 'poll', code: room.code, peer: guest.peer, token: room.token, after: 0 })).status, 401, 'another peer\'s token');

  // impersonation: send as a peer whose token you do not hold
  assert.equal((await api('beam.php', { action: 'signal', code: room.code, peer: 'h', token: guest.token, to: guest.peer, body: 'x' })).status, 401, 'send as host with guest token');
  assert.equal((await api('beam.php', { action: 'signal', code: room.code, peer: 'h', to: guest.peer, body: 'x' })).status, 401, 'send as host with no token');
});

test('ADVERSARIAL: only the host can end a room', async () => {
  const { d: room } = await api('beam.php', { action: 'create' });
  const { d: guest } = await api('beam.php', { action: 'join', code: room.code });
  assert.equal((await api('beam.php', { action: 'end', code: room.code, peer: 'h' })).status, 401, 'end without token');
  assert.equal((await api('beam.php', { action: 'end', code: room.code, peer: guest.peer, token: guest.token })).status, 403, 'guest cannot end');
  assert.equal((await api('beam.php', { action: 'end', code: room.code, peer: 'h', token: room.token })).status, 200, 'host ends');
  // poll still answers, flagging the end, so guests learn "The host ended this beam"
  const polled = await api('beam.php', { action: 'poll', code: room.code, peer: guest.peer, token: guest.token, after: 0 });
  assert.equal(polled.status, 200);
  assert.equal(polled.d.ended, true);
  // ended room refuses further activity
  assert.equal((await api('beam.php', { action: 'join', code: room.code })).status, 404, 'join after end');
  assert.equal((await api('beam.php', { action: 'signal', code: room.code, peer: guest.peer, token: guest.token, to: 'h', body: 'x' })).status, 404, 'signal after end');
  const relay = await fetch(`${BASE}/api/relay.php`, { method: 'POST', body: 'x',
    headers: { ...PROXY_HEADERS, 'Content-Type': 'application/octet-stream', 'X-Beam-Code': room.code } });
  assert.equal(relay.status, 404, 'relay upload after end');
  assert.equal((await api('beam.php', { action: 'poll', code: room.code, peer: 'h', after: 0 })).status, 401, 'poll without token after end');
});
