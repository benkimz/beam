// One-time secrets (api/secret.php) — the server stores opaque ciphertext and
// hands it back exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, b64 } from './helpers.mjs';

test('a secret can be read exactly once, then it is gone', async () => {
  const ct = b64('iv-plus-ciphertext-opaque-blob');
  const c = await api('secret.php', { action: 'create', ct, ttl: 3600 });
  assert.equal(c.status, 200);
  assert.ok(c.d.id);

  const first = await api('secret.php', { action: 'read', id: c.d.id });
  assert.equal(first.status, 200);
  assert.equal(first.d.ct, ct, 'ciphertext round-trips verbatim');

  const second = await api('secret.php', { action: 'read', id: c.d.id });
  assert.equal(second.status, 404, 'the secret is destroyed after one read');
});

test('empty and oversized secrets are rejected', async () => {
  assert.equal((await api('secret.php', { action: 'create', ct: '' })).status, 400);
  const huge = 'A'.repeat(70000);
  assert.equal((await api('secret.php', { action: 'create', ct: huge })).status, 400);
});
