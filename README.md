# beam™

**Send anything to any device.** No app, no account, no size limit.

Live at **[beamtm.com](https://beamtm.com)** ·
[Documentation](https://beamtm.com/docs/) ·
[Security & protocol](https://beamtm.com/security/)

![beam — send anything to any device](og.png)

beam does two things, both with zero setup:

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
  each participant gets a peer id and polls for messages addressed to it. Used only
  to exchange the WebRTC offer/answer/ICE handshake. Sessions self-destruct after
  15 minutes.
- **Transfers** — chunked over a `RTCDataChannel` with backpressure; a host beams
  to every connected peer (star topology, up to 8 guests).
- **Relay fallback** ([api/relay.php](api/relay.php)) — when strict NATs block a
  direct connection, small files (≤ 7 MB) go through a store-and-forward relay
  that deletes them on pickup or session expiry.
- **Secrets** ([api/secret.php](api/secret.php)) — stores ciphertext with a TTL;
  `read` returns it exactly once inside an immediate transaction, deleting it
  atomically so two simultaneous readers cannot both win.
- **Storage** — one SQLite database, kept *outside* the web root. Expired rows are
  garbage-collected opportunistically on requests; no cron required.

## API

Plain JSON over HTTPS, no auth — knowing a code or id *is* the capability.

- OpenAPI 3.0 spec: [api/openapi.json](api/openapi.json) ·
  live at [beamtm.com/api/openapi.json](https://beamtm.com/api/openapi.json)
- Agent-oriented guide: [llms.txt](llms.txt) ·
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
