// Shared helpers for beam's black-box API tests.
// Point BEAM_BASE at any running beam instance (default: the local test server).
export const BASE = process.env.BEAM_BASE || 'http://127.0.0.1:8080';
// Behind a TLS-terminating proxy (e.g. the Docker image, which redirects plain
// HTTP), set BEAM_FORWARDED_PROTO=https to send the header the proxy would add.
export const PROXY_HEADERS = process.env.BEAM_FORWARDED_PROTO
  ? { 'X-Forwarded-Proto': process.env.BEAM_FORWARDED_PROTO } : {};

export async function api(endpoint, payload) {
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PROXY_HEADERS },
    body: JSON.stringify(payload),
  });
  let d = {};
  try { d = await r.json(); } catch {}
  return { status: r.status, d };
}

export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
export const b64json = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
