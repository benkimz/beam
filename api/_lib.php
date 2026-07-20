<?php
declare(strict_types=1);

const BEAM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_TTL = 900;          // beam sessions live 15 minutes
const SECRET_DEFAULT_TTL = 86400;
const SECRET_MAX_TTL = 604800;
const SECRET_MAX_BYTES = 65536;   // ciphertext cap
const SIGNAL_MAX_BYTES = 65536;
const RELAY_MAX_BYTES = 7340032;  // 7 MB relay fallback cap (host's post_max_size is 8M)
const MAX_GUESTS = 8;

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
        guests INTEGER NOT NULL DEFAULT 0
    )');
    // migration for databases created before the guests column existed
    try { $db->exec('ALTER TABLE sessions ADD COLUMN guests INTEGER NOT NULL DEFAULT 0'); } catch (Throwable $e) {}
    $db->exec('CREATE TABLE IF NOT EXISTS msgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        sender TEXT NOT NULL,
        target TEXT NOT NULL,
        body TEXT NOT NULL,
        created INTEGER NOT NULL
    )');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_msgs_code ON msgs (code, target, id)');
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
    $db->prepare('DELETE FROM sessions WHERE created < ?')->execute([$now - SESSION_TTL]);
    $db->prepare('DELETE FROM secrets WHERE expires < ?')->execute([$now]);
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

function beam_session(PDO $db, string $code): ?array {
    $st = $db->prepare('SELECT * FROM sessions WHERE code = ? AND created >= ?');
    $st->execute([$code, time() - SESSION_TTL]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}
