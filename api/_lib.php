<?php
declare(strict_types=1);

const BEAM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_TTL = 900;          // beam sessions live 15 minutes
const CHAT_MAX_AGE = 43200;       // chat rooms: 12 h hard cap...
const CHAT_IDLE_TTL = 900;        // ...with a 15-min sliding idle timeout
const SECRET_DEFAULT_TTL = 86400;
const SECRET_MAX_TTL = 604800;
const SECRET_MAX_BYTES = 65536;   // ciphertext cap
const SIGNAL_MAX_BYTES = 65536;
const RELAY_MAX_BYTES = 7340032;  // 7 MB relay fallback cap (host's post_max_size is 8M)
const MAX_GUESTS = 8;

// TURN relay fallback (Cloudflare Realtime TURN). Configured by the environment:
// BEAM_TURN_ENABLED=1 plus BEAM_TURN_KEY_ID and BEAM_TURN_API_TOKEN; anything else
// means STUN only. The API token is only ever sent to Cloudflare: never stored,
// logged or returned. BEAM_TURN_API_BASE overrides the API base (tests only).
const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const TURN_TTL = 3600;              // credential lifetime, seconds (beams last 15 min; chat refreshes)
const TURN_CONNECT_TIMEOUT = 3;     // seconds
const TURN_TOTAL_TIMEOUT = 5;       // seconds
const TURN_PEER_INTERVAL = 30;      // at most one mint per peer per 30 s
// Mints per session. A beam is at most 9 devices (host + 8 guests) and each device
// mints once, so 20 leaves room for rejoins. A chat room (also up to 9 devices) can
// live 12 h and every device refreshes hourly: 9 x 12 = 108, plus rejoins.
const TURN_MAX_MINTS_BEAM = 20;
const TURN_MAX_MINTS_CHAT = 150;
const TURN_MAX_MINTS_DAY = 20000;   // site-wide ceiling per UTC day (sessions are free to create)
const STUN_SERVERS = [
    ['urls' => 'stun:stun.l.google.com:19302'],
    ['urls' => 'stun:stun1.l.google.com:19302'],
];

function beam_data_dir(): string {
    $dir = dirname(__DIR__, 2) . '/beamtm_data';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    return $dir;
}

function beam_db(): PDO {
    static $db = null;
    if ($db instanceof PDO) {
        return $db;
    }
    $db = new PDO('sqlite:' . beam_data_dir() . '/beam.db');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('CREATE TABLE IF NOT EXISTS sessions (
        code TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        host_seen INTEGER NOT NULL,
        guest_seen INTEGER NOT NULL DEFAULT 0,
        guests INTEGER NOT NULL DEFAULT 0,
        ended INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT \'b\'
    )');
    // migrations for databases created before these columns existed
    try { $db->exec('ALTER TABLE sessions ADD COLUMN guests INTEGER NOT NULL DEFAULT 0'); } catch (Throwable $e) {}
    try { $db->exec('ALTER TABLE sessions ADD COLUMN ended INTEGER NOT NULL DEFAULT 0'); } catch (Throwable $e) {}
    try { $db->exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'b'"); } catch (Throwable $e) {}
    try { $db->exec('ALTER TABLE sessions ADD COLUMN turn_mints INTEGER NOT NULL DEFAULT 0'); } catch (Throwable $e) {}
    $db->exec('CREATE TABLE IF NOT EXISTS msgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        sender TEXT NOT NULL,
        target TEXT NOT NULL,
        body TEXT NOT NULL,
        created INTEGER NOT NULL
    )');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_msgs_code ON msgs (code, target, id)');
    // per-peer auth tokens: knowing a room code no longer lets you read another
    // peer's inbox or speak as them. One row per peer, storing only the hash.
    $db->exec('CREATE TABLE IF NOT EXISTS beam_peers (
        code TEXT NOT NULL,
        peer TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        turn_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, peer)
    )');
    try { $db->exec('ALTER TABLE beam_peers ADD COLUMN turn_at INTEGER NOT NULL DEFAULT 0'); } catch (Throwable $e) {}
    $db->exec('CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        ct TEXT NOT NULL,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
    )');
    $db->exec('CREATE TABLE IF NOT EXISTS stats (
        day TEXT NOT NULL,
        metric TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, metric)
    )');
    return $db;
}

// Aggregate-only usage counters: one integer per metric per UTC day.
// No identifiers, no IPs, no user agents — nothing about *who*.
function beam_count(PDO $db, string $metric): void {
    try {
        $db->prepare('INSERT INTO stats (day, metric, n) VALUES (?, ?, 1)
                      ON CONFLICT(day, metric) DO UPDATE SET n = n + 1')
           ->execute([gmdate('Y-m-d'), $metric]);
    } catch (Throwable $e) {
        // stats must never break the product
    }
}

function beam_cleanup(PDO $db): void {
    // Opportunistic garbage collection on ~10% of requests; no cron needed.
    if (random_int(0, 9) !== 0) {
        return;
    }
    $now = time();
    $db->prepare('DELETE FROM msgs WHERE created < ?')->execute([$now - SESSION_TTL]);
    $db->prepare("DELETE FROM sessions WHERE kind != 'c' AND created < ?")
       ->execute([$now - SESSION_TTL]);
    $db->prepare("DELETE FROM sessions WHERE kind = 'c' AND (created < ? OR (host_seen < ? AND guest_seen < ?))")
       ->execute([$now - CHAT_MAX_AGE, $now - CHAT_IDLE_TTL, $now - CHAT_IDLE_TTL]);
    $db->prepare('DELETE FROM secrets WHERE expires < ?')->execute([$now]);
    // drop auth tokens for rooms that no longer exist
    $db->exec('DELETE FROM beam_peers WHERE code NOT IN (SELECT code FROM sessions)');
    foreach (glob(beam_data_dir() . '/relay/*') ?: [] as $f) {
        if (@filemtime($f) < $now - SESSION_TTL) {
            @unlink($f);
        }
    }
}

function beam_json(array $out, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($out);
    exit;
}

function beam_input(): array {
    $raw = file_get_contents('php://input');
    $d = json_decode($raw === false ? '' : $raw, true);
    return is_array($d) ? $d : [];
}

function beam_new_code(int $len = 6): string {
    $s = '';
    $max = strlen(BEAM_CODE_ALPHABET) - 1;
    for ($i = 0; $i < $len; $i++) {
        $s .= BEAM_CODE_ALPHABET[random_int(0, $max)];
    }
    return $s;
}

function beam_valid_code($c): ?string {
    if (!is_string($c)) {
        return null;
    }
    $c = strtoupper(trim($c));
    return preg_match('/^[A-Z2-9]{6}$/', $c) === 1 ? $c : null;
}

function beam_valid_peer($p): ?string {
    if (!is_string($p)) {
        return null;
    }
    return preg_match('/^(h|g[A-Z2-9]{4})$/', $p) === 1 ? $p : null;
}

function beam_peer_token(): string {
    return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
}

// Register a peer's token (stores only the hash). Returns the plaintext token.
function beam_peer_register(PDO $db, string $code, string $peer): string {
    $token = beam_peer_token();
    $db->prepare('INSERT OR REPLACE INTO beam_peers (code, peer, token_hash) VALUES (?, ?, ?)')
       ->execute([$code, $peer, hash('sha256', $token)]);
    return $token;
}

// Constant-time check that (code, peer) presented a valid token.
function beam_auth(PDO $db, string $code, string $peer, $token): bool {
    if (!is_string($token) || $token === '') {
        return false;
    }
    $st = $db->prepare('SELECT token_hash FROM beam_peers WHERE code = ? AND peer = ?');
    $st->execute([$code, $peer]);
    $h = $st->fetchColumn();
    return $h !== false && hash_equals($h, hash('sha256', $token));
}

function beam_session(PDO $db, string $code): ?array {
    $st = $db->prepare('SELECT * FROM sessions WHERE code = ?');
    $st->execute([$code]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        return null;
    }
    $now = time();
    if (($row['kind'] ?? 'b') === 'c') {
        // chat rooms: sliding idle timeout under a hard age cap
        $lastSeen = max((int)$row['host_seen'], (int)$row['guest_seen']);
        $alive = (int)$row['created'] >= $now - CHAT_MAX_AGE
              && $lastSeen >= $now - CHAT_IDLE_TTL;
    } else {
        $alive = (int)$row['created'] >= $now - SESSION_TTL;
    }
    return $alive ? $row : null;
}

// ---------- TURN relay credentials ----------

function beam_stun_only(): array {
    return ['iceServers' => STUN_SERVERS, 'ttl' => 0, 'relay' => false];
}

// ICE servers for an authenticated peer of a live session: STUN first, then TURN
// credentials minted by Cloudflare when the relay is enabled and within the limits.
// Every failure path degrades to STUN only; this never throws.
function beam_turn_ice(PDO $db, array $session, string $peer): array {
    // On only when exactly "1". compose env_file passes unset values as '', so an
    // empty or whitespace-only key or token counts as unset: STUN only, no call out.
    if (getenv('BEAM_TURN_ENABLED') !== '1') {
        return beam_stun_only();
    }
    $keyId = trim((string) getenv('BEAM_TURN_KEY_ID'));
    $apiToken = trim((string) getenv('BEAM_TURN_API_TOKEN'));
    if (preg_match('/^[A-Za-z0-9_-]{1,128}$/', $keyId) !== 1
        || preg_match('/^[\x21-\x7e]{1,512}$/', $apiToken) !== 1) {
        return beam_stun_only();
    }
    $base = getenv('BEAM_TURN_API_BASE');
    $base = is_string($base) && preg_match('#^https?://#', $base) === 1 ? rtrim($base, '/') : TURN_API_BASE;
    $code = (string) $session['code'];
    $max = ($session['kind'] ?? 'b') === 'c' ? TURN_MAX_MINTS_CHAT : TURN_MAX_MINTS_BEAM;
    $now = time();
    try {
        $st = $db->prepare("SELECT n FROM stats WHERE day = ? AND metric = 'turn_minted'");
        $st->execute([gmdate('Y-m-d')]);
        $today = (int) $st->fetchColumn();
        $st->closeCursor();
        if ($today >= TURN_MAX_MINTS_DAY) {
            return beam_stun_only();
        }
        // atomic claims: this peer's 30 s window, then a slot in the session's budget
        $st = $db->prepare('UPDATE beam_peers SET turn_at = ? WHERE code = ? AND peer = ? AND turn_at <= ?');
        $st->execute([$now, $code, $peer, $now - TURN_PEER_INTERVAL]);
        if ($st->rowCount() === 0) {
            return beam_stun_only();
        }
        $st = $db->prepare('UPDATE sessions SET turn_mints = turn_mints + 1 WHERE code = ? AND turn_mints < ?');
        $st->execute([$code, $max]);
        if ($st->rowCount() === 0) {
            return beam_stun_only();
        }
    } catch (Throwable $e) {
        error_log('beam turn: rate-limit check failed');
        return beam_stun_only();
    }
    beam_count($db, 'turn_minted');

    $turn = beam_turn_generate($base, $keyId, $apiToken);
    if ($turn === null) {
        return beam_stun_only();
    }
    return ['iceServers' => array_merge(STUN_SERVERS, $turn), 'ttl' => TURN_TTL, 'relay' => true];
}

// POST {base}/turn/keys/{key id}/credentials/generate-ice-servers with {"ttl": N}.
// Returns only the TURN entries (urls + username + credential), or null on failure.
// Error logs carry a curl errno or HTTP status only: never the URL, token or body.
function beam_turn_generate(string $base, string $keyId, string $apiToken): ?array {
    if (!function_exists('curl_init')) {
        error_log('beam turn: curl unavailable');
        return null;
    }
    $ch = curl_init($base . '/turn/keys/' . rawurlencode($keyId) . '/credentials/generate-ice-servers');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['ttl' => TURN_TTL]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $apiToken, 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => TURN_CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT => TURN_TOTAL_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $errno !== 0) {
        error_log("beam turn: request failed (curl $errno)");
        return null;
    }
    if ($status < 200 || $status > 299) {
        error_log("beam turn: request failed (http $status)");
        return null;
    }
    $d = json_decode((string) $raw, true);
    $servers = is_array($d) && is_array($d['iceServers'] ?? null) ? $d['iceServers'] : [];
    $out = [];
    foreach ($servers as $s) {
        if (!is_array($s) || !is_string($s['username'] ?? null) || !is_string($s['credential'] ?? null)) {
            continue;
        }
        $urls = [];
        foreach ((array) ($s['urls'] ?? []) as $u) {
            // TURN only (we list our own STUN); port 53 is blocked by browsers and only times out
            if (is_string($u)
                && preg_match('#^turns?:[A-Za-z0-9.\-]+:(\d+)(\?transport=(udp|tcp))?$#', $u, $m) === 1
                && $m[1] !== '53') {
                $urls[] = $u;
            }
        }
        if ($urls) {
            $out[] = ['urls' => $urls, 'username' => $s['username'], 'credential' => $s['credential']];
        }
    }
    if (!$out) {
        error_log('beam turn: unexpected response');
        return null;
    }
    return $out;
}
