// Shared helpers for beam's black-box API tests.
// Point BEAM_BASE at any running beam instance (default: the local test server).
export const BASE = process.env.BEAM_BASE || 'http://127.0.0.1:8080';

export async function api(endpoint, payload) {
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let d = {};
  try { d = await r.json(); } catch {}
  return { status: r.status, d };
}

export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
export const b64json = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
