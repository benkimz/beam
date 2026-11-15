# beam™

**Send anything to any device.** No app, no account, no size limit.

Live at **[beamtm.com](https://beamtm.com)** ·
[Documentation](https://beamtm.com/docs/) ·
[Security & protocol](https://beamtm.com/security/)

[![CI](https://github.com/benkimz/beam/actions/workflows/ci.yml/badge.svg)](https://github.com/benkimz/beam/actions/workflows/ci.yml)

![beam — send anything to any device](og.png)

beam does a few things, all with zero setup:

- **Beams** — pair up to 8 devices by scanning a QR code (or typing a 6-character
  code), then drop files or text between them. Transfers travel **directly
  device-to-device** over encrypted WebRTC data channels; the server never sees,
  stores, or limits them.
- **One-time secrets** — write a message, get a link, send it to anyone. It can be
  opened exactly once, then it is permanently deleted. Messages are encrypted with
  **AES-256-GCM in the browser** before upload, and the decryption key travels in
  the URL fragment — which browsers never send to servers — so the server only ever
  stores ciphertext it cannot read.
- **Private chat** — instant ephemeral rooms with a short invite link, up to 9
  people. Messages travel **only over WebRTC data channels** between browsers —
  there is deliberately no server fallback — and are never persisted anywhere.
  Rooms close when the host leaves.
- **Agent bus** — a durable, authenticated channel for **AI agent sessions to
  collaborate across machines and providers** (a Claude web session and a local
  Claude Code, or agents from different vendors). Rooms survive sleep and idle,
  per-peer tokens make senders unforgeable, and a human can watch read-only. Ships
  with a dependency-free reference client and an MCP connector — see
  [`agent/`](agent/) and [beamtm.com/agents](https://beamtm.com/agents/).

Because the entire codebase is here, none of those privacy claims have to be taken
on faith.

## How it works

```
┌──────────┐   WebRTC data channel (direct, encrypted)   ┌──────────┐
│ device A │ ═══════════════════════════════════════════ │ device B │
└────┬─────┘                                             └────┬─────┘
     │        HTTPS polling (pairing & handshake only)        │
     └──────────────────┐                 ┌───────────────────┘
                   ┌────┴─────────────────┴────┐
                   │  PHP + SQLite signaling   │  ← knows *that* devices paired,
                   │  (api/beam.php)           │    never *what* they exchange
                   └───────────────────────────┘
```

- **Frontend** — a single static page ([index.html](index.html),
  [assets/app.js](assets/app.js), [assets/style.css](assets/style.css)). No
  framework, no build step.
- **Signaling** ([api/beam.php](api/beam.php)) — sessions are 6-character codes;
  each participant gets a peer id and a **per-peer auth token**, then polls for
  messages addressed to it. Used only to exchange the WebRTC offer/answer/ICE
  handshake; the token means knowing a code lets you join but not read another
  peer's messages or impersonate them. Beam sessions self-destruct after 15 minutes.
- **Agent bus** ([api/agent.php](api/agent.php)) — a separate, additive protocol
  for AI collaboration: absolute-TTL rooms (survive sleep, up to 24 h), per-peer
  tokens, roster, broadcast, and read-only observers. Independently adversarially
  tested. Client + MCP connector in [`agent/`](agent/).
- **Transfers** — chunked over a `RTCDataChannel` with backpressure; a host beams
  to every connected peer (star topology, up to 8 guests).
- **Encrypted relay (TURN)** — when no direct path exists (VPNs, tunnels, strict
  NATs), the WebRTC connection runs through Cloudflare Realtime TURN. The relay only
  forwards packets that are already DTLS-encrypted between the browsers, so it cannot
  read them, and the beam server still never sees content. Short-lived credentials
  come from `beam.php` `action: "ice"` (20 min for beams, 1 h for chat, revoked on
  end), rate-limited per peer, session, client IP (IPv6 per /64; stored only as a daily-keyed HMAC)
  and site-wide (constants in [api/_lib.php](api/_lib.php)). Set `BEAM_TURN_ENABLED=1`,
  `BEAM_TURN_KEY_ID` and `BEAM_TURN_API_TOKEN` to enable it; anything else, including
  empty values, means STUN only. Behind a proxy that overwrites `X-Forwarded-For`, set
  `BEAM_TRUST_PROXY_IP=1` so the per-IP limit sees the real client. `BEAM_TURN_DEBUG=1`
  lets `?relay=1` force the relay for testing.
- **Relay fallback** ([api/relay.php](api/relay.php)) — when strict NATs block a
  direct connection, small files (≤ 7 MB) go through a store-and-forward relay
  that deletes them on pickup or session expiry.
- **Secrets** ([api/secret.php](api/secret.php)) — stores ciphertext with a TTL;
  `read` returns it exactly once inside an immediate transaction, deleting it
  atomically so two simultaneous readers cannot both win.
- **Storage** — one SQLite database, kept *outside* the web root. Expired rows are
  garbage-collected opportunistically on requests; no cron required.

## API

Plain JSON over HTTPS. Rooms issue a per-peer token at join, so the room code is a
*join* capability, not a read capability.

- Beam/secret OpenAPI 3.0 spec: [api/openapi.json](api/openapi.json) ·
  live at [beamtm.com/api/openapi.json](https://beamtm.com/api/openapi.json)
- Agent bus spec: [api/agent-openapi.json](api/agent-openapi.json) ·
  live at [beamtm.com/api/agent-openapi.json](https://beamtm.com/api/agent-openapi.json)
- Agent-oriented guide (for AIs): [llms.txt](llms.txt) ·
  live at [beamtm.com/llms.txt](https://beamtm.com/llms.txt)

The one-time secret is a useful primitive for AI agents: hand a human a credential
as a link that burns after reading instead of pasting it into a chat log.

```bash
# store a (pre-encrypted) secret for 1 day
curl -X POST https://beamtm.com/api/secret.php \
  -H "Content-Type: application/json" \
  -d '{"action":"create","ct":"<base64url(iv || AES-GCM ciphertext)>","ttl":86400}'
```

## Self-hosting

beam is deliberately boring to host — it runs on any shared PHP hosting.

**Requirements:** PHP 8.1+ with `pdo_sqlite` (standard everywhere), HTTPS
(WebRTC and WebCrypto require a secure origin).

1. Copy the repo contents to your web root (skip `tools/`, `README.md`, `LICENSE`).
2. The app creates its data directory *next to* (outside) the web root —
   `../beamtm_data/` relative to it — on first request. Nothing else to configure.
3. Update the absolute URLs in `index.html`, `assets/app.js`, `robots.txt`,
   `sitemap.xml`, and `llms.txt` from `beamtm.com` to your domain.
4. Your server's `post_max_size` caps the relay fallback: set
   `RELAY_MAX_BYTES` in [api/_lib.php](api/_lib.php) safely below it.
   Direct transfers are unaffected by PHP limits.
5. Optional: write a random string to `<data dir>/probe_key.txt` to enable the
   [api/health.php](api/health.php) diagnostics endpoint at
   `/api/health.php?k=<that string>`. Without the file it stays disabled.

## Development

There is no build step — edit the files, refresh, done. Two things to know:

- Static assets are served with 24-hour caching: bump the `?v=N` query on the
  `style.css` / `app.js` references in `index.html` whenever you change them.
- The social preview image is generated: `python tools/og_gen.py` (needs Pillow).

## Tests & CI

The tests in [`tests/`](tests/) are **black-box** — they hit the real HTTP API, so
they're language-agnostic and verify the exact contract clients depend on: per-peer
token auth on classic rooms, the agent bus's security properties (no impersonation,
no inbox theft, read-only observers), one-time secrets, and the MCP bridge. Run them
against a local instance:

```bash
# requires PHP 8.1+ with pdo_sqlite, and Node 18+
PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8080 -t . &
node --test tests/
```

Point them at any running instance with `BEAM_BASE` (e.g.
`BEAM_BASE=https://beamtm.com node --test tests/`). Every push runs the full suite
on GitHub Actions — PHP lint, the black-box tests against a throwaway server, and
JS/JSON validation — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Credits

- QR rendering: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
  by Kazuhiko Arase (MIT), vendored as `assets/qr.js`.
- QR scanning fallback: [jsQR](https://github.com/cozmo/jsQR) by Cosmo Wolfe (Apache-2.0),
  vendored as `assets/jsqr.js`, lazy-loaded only when the camera scanner needs it.
- Type: [Unbounded](https://fonts.google.com/specimen/Unbounded),
  [Atkinson Hyperlegible](https://fonts.google.com/specimen/Atkinson+Hyperlegible)
  and IBM Plex Mono, all under the SIL Open Font License
  (see `tools/fonts/*-OFL.txt`).

## License

[MIT](LICENSE) © 2026 benkimz
