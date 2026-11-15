// Stand-in for Cloudflare Realtime TURN's credential API, for the TURN tests.
//   node tests/turn-stub.mjs            (API on :8787, control on :8788)
// Point beam at it with BEAM_TURN_API_BASE=http://<host>:8787/v1. It answers
//   POST /v1/turn/keys/<id>/credentials/generate-ice-servers
// like Cloudflare does (201 + iceServers), but only for "Authorization: Bearer
// $BEAM_TURN_API_TOKEN". The control port lets tests switch failure modes:
//   POST /mode {"mode": "ok" | "down" | "error" | "garbage" | "slow"}   GET /stats
// "down" closes the API port (connection refused); the others keep it open.
import http from 'node:http';

const API_PORT = Number(process.env.TURN_STUB_PORT || 8787);
const CTL_PORT = Number(process.env.TURN_STUB_CONTROL_PORT || 8788);
const HOST = process.env.TURN_STUB_HOST || '0.0.0.0';
const TOKEN = process.env.BEAM_TURN_API_TOKEN || 'stub-token';

// Cloudflare's documented example response, plus a port-53 URL that beam must drop.
const STUB_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:443?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'stub-user-0123456789abcdef',
      credential: 'stub-cred-fedcba9876543210',
    },
  ],
};

let mode = 'ok';
const stats = { count: 0, last: null };
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

const api = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const m = /^\/v1\/turn\/keys\/([^/]+)\/credentials\/generate-ice-servers$/.exec(req.url);
  stats.count++;
  let ttl = null;
  try { ttl = JSON.parse(body).ttl; } catch {}
  stats.last = { method: req.method, keyId: m && m[1], authOk: req.headers.authorization === `Bearer ${TOKEN}`,
    contentType: req.headers['content-type'], ttl };
  if (req.method !== 'POST' || !m) return send(res, 404, { success: false });
  if (!stats.last.authOk) return send(res, 401, { success: false, errors: [{ message: 'Authentication error' }] });
  if (mode === 'error') return send(res, 500, { success: false });
  if (mode === 'garbage') return send(res, 201, '<html>not json');
  if (mode === 'slow') { setTimeout(() => send(res, 201, STUB_RESPONSE), 8000); return; }
  send(res, 201, STUB_RESPONSE);
});

let apiUp = false;
const startApi = () => new Promise((r) => { if (apiUp) return r(); api.listen(API_PORT, HOST, () => { apiUp = true; r(); }); });
const stopApi = () => new Promise((r) => {
  if (!apiUp) return r();
  apiUp = false;
  api.close(() => r());
  api.closeAllConnections();
});

const ctl = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/stats') return send(res, 200, { mode, ...stats });
  if (req.method === 'POST' && req.url === '/mode') {
    let next = 'ok';
    try { next = JSON.parse(await readBody(req)).mode; } catch {}
    if (!['ok', 'down', 'error', 'garbage', 'slow'].includes(next)) return send(res, 400, { error: 'mode' });
    mode = next;
    if (mode === 'down') await stopApi(); else await startApi();
    return send(res, 200, { mode });
  }
  send(res, 404, { error: 'not found' });
});

await startApi();
ctl.listen(CTL_PORT, "127.0.0.1", () => console.log(`turn stub: api :${API_PORT}, control :${CTL_PORT}`));
