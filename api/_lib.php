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
// (including empty values) means STUN only. The API token is only ever sent to
// Cloudflare: never stored, logged or returned. BEAM_TURN_API_BASE overrides the
// API base for tests (https, or plain http to a local test host only).
// BEAM_TRUST_PROXY_IP=1: take the client IP from X-Forwarded-For (only behind our
// proxy, which overwrites it). BEAM_TURN_DEBUG=1: let ?relay=1 force the relay.
// Every credential is billed by the byte, so minting is capped several ways.
const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const TURN_TTL_BEAM = 1200;         // credential lifetime, s: beams last 15 min
const TURN_TTL_CHAT = 3600;         // chat rooms renegotiate with fresh credentials before expiry
const TURN_CONNECT_TIMEOUT_MS = 1000; // give up well before the client's 2 s deadline
const TURN_TOTAL_TIMEOUT_MS = 1500;
const TURN_PEER_INTERVAL = 30;      // at most one mint per peer per 30 s
// Mints per session. A beam is at most 9 devices (host + 8 guests) and each device
// mints once, so 20 leaves room for rejoins. A chat room (also up to 9 devices) can
// live 12 h and every device refreshes hourly: 9 x 12 = 108, plus rejoins.
const TURN_MAX_MINTS_BEAM = 20;
const TURN_MAX_MINTS_CHAT = 150;
// Per client IP (stored only as an HMAC under a key that rotates daily).
const TURN_IP_WINDOW = 600;         // 10 minutes
const TURN_IP_MAX_WINDOW = 6;
const TURN_IP_MAX_DAY = 30;
const TURN_MAX_MINTS_DAY = 1000;    // site-wide ceiling per UTC day
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
    // TURN: usernames of minted credentials (not secret), so `end` can revoke them
    $db->exec('CREATE TABLE IF NOT EXISTS turn_creds (
        code TEXT NOT NULL,
        username TEXT NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY (code, username)
    )');
    // TURN per-IP mint counters. h is HMAC-SHA256(daily key, IP): no raw IPs stored.
    $db->exec('CREATE TABLE IF NOT EXISTS turn_ip (
        h TEXT NOT NULL,
        period TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL,
        PRIMARY KEY (h, period)
    )');
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
    $db->exec('DELETE FROM turn_creds WHERE code NOT IN (SELECT code FROM sessions)');
    $db->prepare('DELETE FROM turn_ip WHERE expires < ?')->execute([$now]);
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

function beam_turn_debug(): bool {
    return getenv('BEAM_TURN_DEBUG') === '1';
}

function beam_stun_only(): array {
    return ['iceServers' => STUN_SERVERS, 'ttl' => 0, 'relay' => false, 'debug' => beam_turn_debug()];
}

// The API base: Cloudflare unless BEAM_TURN_API_BASE overrides it. An override must
// be https, or plain http to a local test host. Anything else is refused (null).
function beam_turn_base(): ?string {
    $b = trim((string) getenv('BEAM_TURN_API_BASE'));
    if ($b === '') {
        return TURN_API_BASE;
    }
    $u = parse_url($b);
    $scheme = strtolower((string) ($u['scheme'] ?? ''));
    $host = strtolower((string) ($u['host'] ?? ''));
    $clean = is_array($u) && $host !== '' && !isset($u['user']) && !isset($u['pass'])
        && !isset($u['query']) && !isset($u['fragment']);
    $local = in_array($host, ['127.0.0.1', 'localhost', 'host.docker.internal'], true);
    if ($clean && ($scheme === 'https' || ($scheme === 'http' && $local))) {
        return rtrim($b, '/');
    }
    error_log('beam turn: BEAM_TURN_API_BASE refused (must be https)');
    return null;
}

// [base, key id, API token] when the relay may be used, else null. compose env_file
// passes unset values as '', so empty or whitespace-only counts as unset.
function beam_turn_config(bool $requireEnabled = true): ?array {
    if ($requireEnabled && getenv('BEAM_TURN_ENABLED') !== '1') {
        return null;
    }
    $keyId = trim((string) getenv('BEAM_TURN_KEY_ID'));
    $apiToken = trim((string) getenv('BEAM_TURN_API_TOKEN'));
    if (preg_match('/^[A-Za-z0-9_-]{1,128}$/', $keyId) !== 1
        || preg_match('/^[\x21-\x7e]{1,512}$/', $apiToken) !== 1) {
        return null;
    }
    $base = beam_turn_base();
    return $base === null ? null : [$base, $keyId, $apiToken];
}

// The client IP, for rate limiting only. X-Forwarded-For is read only when
// BEAM_TRUST_PROXY_IP=1 (our proxy overwrites it); otherwise it is ignored.
function beam_client_ip(): string {
    if (getenv('BEAM_TRUST_PROXY_IP') === '1') {
        $first = trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))[0]);
        if (filter_var($first, FILTER_VALIDATE_IP) !== false) {
            return $first;
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

// Today's random HMAC key for IP hashing, kept in the data dir. A new key each UTC
// day; older keys are deleted, so stored hashes can't be linked to IPs afterwards.
function beam_ip_key(): ?string {
    $dir = beam_data_dir();
    $file = $dir . '/iphash-' . gmdate('Y-m-d') . '.key';
    $ok = static fn($k) => is_string($k) && preg_match('/^[0-9a-f]{64}$/', $k) === 1;
    $k = @file_get_contents($file);
    if ($ok($k)) {
        return $k;
    }
    $h = @fopen($file, 'x'); // exclusive create: one writer wins a race
    if ($h !== false) {
        $k = bin2hex(random_bytes(32));
        fwrite($h, $k);
        fclose($h);
        @chmod($file, 0600);
        foreach (glob($dir . '/iphash-*.key') ?: [] as $old) {
            if ($old !== $file) {
                @unlink($old);
            }
        }
        return $k;
    }
    for ($i = 0; $i < 5; $i++) { // another request is writing it
        usleep(10000);
        $k = @file_get_contents($file);
        if ($ok($k)) {
            return $k;
        }
    }
    return null;
}

// ICE servers for an authenticated peer of a live session: STUN first, then TURN
// credentials minted by Cloudflare when the relay is enabled and within every limit.
// Every failure path degrades to STUN only; this never throws.
function beam_turn_ice(PDO $db, array $session, string $peer): array {
    $cfg = beam_turn_config();
    if ($cfg === null) {
        return beam_stun_only();
    }
    $code = (string) $session['code'];
    $chat = ($session['kind'] ?? 'b') === 'c';
    $ttl = $chat ? TURN_TTL_CHAT : TURN_TTL_BEAM;
    $key = beam_ip_key();
    if ($key === null) {
        error_log('beam turn: no IP hash key');
        return beam_stun_only();
    }
    $iph = hash_hmac('sha256', beam_client_ip(), $key);
    $claims = beam_turn_reserve($db, $code, $peer, $chat ? TURN_MAX_MINTS_CHAT : TURN_MAX_MINTS_BEAM, $iph);
    if ($claims === null) {
        return beam_stun_only();
    }
    $turn = beam_turn_generate($cfg[0], $cfg[1], $cfg[2], $ttl);
    if ($turn === null) {
        beam_turn_refund($db, $claims);
        return beam_stun_only();
    }
    try {
        $ins = $db->prepare('INSERT OR IGNORE INTO turn_creds (code, username, created) VALUES (?, ?, ?)');
        foreach ($turn['usernames'] as $u) {
            $ins->execute([$code, $u, time()]);
        }
    } catch (Throwable $e) {
        error_log('beam turn: could not record credential for revoke');
    }
    return ['iceServers' => array_merge(STUN_SERVERS, $turn['servers']), 'ttl' => $ttl, 'relay' => true,
            'debug' => beam_turn_debug()];
}

// Claim a mint under every limit in one transaction: the peer's 30 s window, the
// session budget, the IP's 10-min and daily budgets, the site-wide daily cap. Each
// is an atomic conditional update, so concurrent requests cannot overshoot. Returns
// the claims (for a refund if Cloudflare then fails), or null when any limit is hit.
function beam_turn_reserve(PDO $db, string $code, string $peer, int $sessionMax, string $iph): ?array {
    $now = time();
    $win = 'w' . intdiv($now, TURN_IP_WINDOW);
    $day = gmdate('Y-m-d');
    $ipUp = $db->prepare('INSERT INTO turn_ip (h, period, n, expires) VALUES (?, ?, 1, ?)
                          ON CONFLICT(h, period) DO UPDATE SET n = n + 1 WHERE n < ?');
    try {
        $db->beginTransaction();
        $steps = [
            [$db->prepare('UPDATE beam_peers SET turn_at = ? WHERE code = ? AND peer = ? AND turn_at <= ?'),
             [$now, $code, $peer, $now - TURN_PEER_INTERVAL]],
            [$db->prepare('UPDATE sessions SET turn_mints = turn_mints + 1 WHERE code = ? AND turn_mints < ?'),
             [$code, $sessionMax]],
            [$ipUp, [$iph, $win, $now + 2 * TURN_IP_WINDOW, TURN_IP_MAX_WINDOW]],
            [$ipUp, [$iph, 'd' . $day, $now + 2 * 86400, TURN_IP_MAX_DAY]],
            [$db->prepare("INSERT INTO stats (day, metric, n) VALUES (?, 'turn_minted', 1)
                           ON CONFLICT(day, metric) DO UPDATE SET n = n + 1 WHERE n < ?"),
             [$day, TURN_MAX_MINTS_DAY]],
        ];
        foreach ($steps as [$st, $args]) {
            $st->execute($args);
            if ($st->rowCount() === 0) {
                $db->rollBack();
                return null;
            }
        }
        $db->commit();
        return ['code' => $code, 'iph' => $iph, 'win' => $win, 'day' => $day];
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        error_log('beam turn: rate-limit check failed');
        return null;
    }
}

// Give back the budget a failed mint claimed, so counters only reflect real mints.
// The peer's 30 s window is kept, so a failing Cloudflare is not hammered.
function beam_turn_refund(PDO $db, array $c): void {
    try {
        $db->beginTransaction();
        $db->prepare('UPDATE sessions SET turn_mints = turn_mints - 1 WHERE code = ? AND turn_mints > 0')
           ->execute([$c['code']]);
        $db->prepare('UPDATE turn_ip SET n = n - 1 WHERE h = ? AND period IN (?, ?) AND n > 0')
           ->execute([$c['iph'], $c['win'], 'd' . $c['day']]);
        $db->prepare("UPDATE stats SET n = n - 1 WHERE day = ? AND metric = 'turn_minted' AND n > 0")
           ->execute([$c['day']]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        error_log('beam turn: refund failed');
    }
}

function beam_turn_curl(string $url, string $apiToken, ?string $json) {
    $ch = curl_init($url);
    $headers = ['Authorization: Bearer ' . $apiToken];
    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $json ?? '',
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_NOSIGNAL => true,
        CURLOPT_CONNECTTIMEOUT_MS => TURN_CONNECT_TIMEOUT_MS,
        CURLOPT_TIMEOUT_MS => TURN_TOTAL_TIMEOUT_MS,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    return $ch;
}

// POST {base}/turn/keys/{key id}/credentials/generate-ice-servers with {"ttl": N}.
// Returns the TURN entries (urls + username + credential) and their usernames, or
// null on failure. Error logs carry a curl errno or HTTP status only: never the URL,
// token or body.
function beam_turn_generate(string $base, string $keyId, string $apiToken, int $ttl): ?array {
    if (!function_exists('curl_init')) {
        error_log('beam turn: curl unavailable');
        return null;
    }
    $ch = beam_turn_curl($base . '/turn/keys/' . rawurlencode($keyId) . '/credentials/generate-ice-servers',
                         $apiToken, json_encode(['ttl' => $ttl]));
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
    $list = is_array($d) && is_array($d['iceServers'] ?? null) ? $d['iceServers'] : [];
    $servers = [];
    $users = [];
    foreach ($list as $s) {
        if (!is_array($s) || !is_string($s['username'] ?? null) || !is_string($s['credential'] ?? null)
            || preg_match('/^[A-Za-z0-9._~:-]{1,256}$/', $s['username']) !== 1) {
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
            $servers[] = ['urls' => $urls, 'username' => $s['username'], 'credential' => $s['credential']];
            $users[] = $s['username'];
        }
    }
    if (!$servers) {
        error_log('beam turn: unexpected response');
        return null;
    }
    return ['servers' => $servers, 'usernames' => array_values(array_unique($users))];
}

// On end: revoke the session's TURN credentials so they stop working at once.
// POST {base}/turn/keys/{key id}/credentials/{username}/revoke (204 on success).
// Best effort, in parallel, bounded by the short timeouts; never affects `end`.
function beam_turn_revoke(PDO $db, string $code): void {
    try {
        $st = $db->prepare('SELECT username FROM turn_creds WHERE code = ?');
        $st->execute([$code]);
        $names = $st->fetchAll(PDO::FETCH_COLUMN);
        $st->closeCursor();
        if (!$names) {
            return;
        }
        $db->prepare('DELETE FROM turn_creds WHERE code = ?')->execute([$code]);
        $cfg = beam_turn_config(false); // revoke even if the kill switch was flipped since
        if ($cfg === null || !function_exists('curl_multi_init')) {
            return;
        }
        [$base, $keyId, $apiToken] = $cfg;
        $mh = curl_multi_init();
        $handles = [];
        foreach ($names as $name) {
            $ch = beam_turn_curl($base . '/turn/keys/' . rawurlencode($keyId) . '/credentials/'
                                 . rawurlencode((string) $name) . '/revoke', $apiToken, null);
            curl_multi_add_handle($mh, $ch);
            $handles[] = $ch;
        }
        do {
            $rc = curl_multi_exec($mh, $running);
            if ($running) {
                curl_multi_select($mh, 0.2);
            }
        } while ($running && $rc === CURLM_OK);
        $failed = 0;
        foreach ($handles as $ch) {
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($status < 200 || $status > 299) {
                $failed++;
            }
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
        if ($failed) {
            error_log("beam turn: revoke failed for $failed of " . count($handles));
        }
    } catch (Throwable $e) {
        error_log('beam turn: revoke failed');
    }
}
