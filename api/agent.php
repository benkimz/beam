<?php
// beam agent bus — durable, authenticated, multi-party rooms for AI sessions
// collaborating across machines and providers.
//
// A DIFFERENT PROTOCOL FROM HUMAN BEAM/CHAT ROOMS, on purpose:
//   - ABSOLUTE TTL: a room lives to its deadline regardless of polling, so a
//     sleeping/idle session never "nukes" the room. Wake up, poll after=<cursor>,
//     replay everything missed.
//   - PER-PEER TOKENS: the room code is an address, not the credential. The
//     sender is derived from an unforgeable token — there is no spoofable "from".
//   - ROSTER, BROADCAST, READ-ONLY OBSERVERS, LONG-POLL, distinct error codes.
//
// Additive and isolated: this file shares only safe primitives from _lib.php and
// uses its own tables. It does not touch beam.php or any human-room behavior.
declare(strict_types=1);
require __DIR__ . '/_lib.php';

const AGENT_DEFAULT_TTL   = 14400;   // 4 hours
const AGENT_MIN_TTL       = 300;
const AGENT_MAX_TTL       = 86400;   // 24 h hard cap
const AGENT_MAX_MEMBERS   = 8;
const AGENT_MAX_OBSERVERS = 8;
const AGENT_MSG_MAX       = 65536;
const AGENT_WAIT_MAX      = 15000;   // long-poll cap (ms), safely under max_execution_time
const AGENT_MAX_LIVE      = 500;     // abuse cap on concurrent rooms

function agent_tables(PDO $db): void {
    $db->exec('CREATE TABLE IF NOT EXISTS agent_rooms (
        code TEXT PRIMARY KEY,
        obs_code TEXT,
        created INTEGER NOT NULL,
        ttl INTEGER NOT NULL,
        observable INTEGER NOT NULL DEFAULT 0,
        ended INTEGER NOT NULL DEFAULT 0
    )');
    $db->exec('CREATE TABLE IF NOT EXISTS agent_peers (
        code TEXT NOT NULL,
        peer TEXT NOT NULL,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        joined INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (code, peer)
    )');
    $db->exec('CREATE TABLE IF NOT EXISTS agent_msgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        sender TEXT NOT NULL,
        target TEXT NOT NULL,
        body TEXT NOT NULL,
        created INTEGER NOT NULL
    )');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_agent_msgs ON agent_msgs (code, id)');
}

function agent_cleanup(PDO $db): void {
    if (random_int(0, 9) !== 0) return;
    $now = time();
    // absolute-TTL expiry: dies at created+ttl regardless of activity
    $dead = $db->query('SELECT code FROM agent_rooms WHERE ended = 1 OR (created + ttl) < ' . $now)
               ->fetchAll(PDO::FETCH_COLUMN);
    foreach ($dead as $code) {
        $db->prepare('DELETE FROM agent_rooms WHERE code = ?')->execute([$code]);
        $db->prepare('DELETE FROM agent_peers WHERE code = ?')->execute([$code]);
        $db->prepare('DELETE FROM agent_msgs  WHERE code = ?')->execute([$code]);
    }
}

function agent_err(string $code, int $status): void { beam_json(['error' => $code], $status); }

function agent_token(): string {
    return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
}

function agent_valid_peer($p): ?string {
    if (!is_string($p)) return null;
    return preg_match('/^(h|[go][A-Z2-9]{4})$/', $p) === 1 ? $p : null;
}

// a message target: broadcast 'room', the host, or a member — never an observer.
function agent_valid_target($t): ?string {
    if (!is_string($t)) return null;
    if ($t === 'room') return 'room';
    return preg_match('/^(h|g[A-Z2-9]{4})$/', $t) === 1 ? $t : null;
}

function agent_room_alive(?array $r): bool {
    return $r !== null && (int)$r['ended'] === 0
        && ((int)$r['created'] + (int)$r['ttl']) >= time();
}

// Resolve a room by member code OR observer code. Returns [row, isObserverCode].
function agent_resolve(PDO $db, string $code): array {
    $st = $db->prepare('SELECT * FROM agent_rooms WHERE code = ? OR obs_code = ?');
    $st->execute([$code, $code]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    if ($r === false) return [null, false];
    return [$r, ($r['obs_code'] !== null && $code === $r['obs_code'] && $code !== $r['code'])];
}

// Authenticate (roomCode, peer, token) → role, or null. Constant-time.
function agent_auth(PDO $db, string $roomCode, string $peer, $token): ?string {
    if (!is_string($token) || $token === '') return null;
    $st = $db->prepare('SELECT role, token_hash FROM agent_peers WHERE code = ? AND peer = ?');
    $st->execute([$roomCode, $peer]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if ($row === false) return null;
    return hash_equals($row['token_hash'], hash('sha256', $token)) ? $row['role'] : null;
}

function agent_roster(PDO $db, string $roomCode): array {
    $st = $db->prepare('SELECT peer, role FROM agent_peers WHERE code = ? ORDER BY joined');
    $st->execute([$roomCode]);
    return $st->fetchAll(PDO::FETCH_ASSOC);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    agent_err('post_only', 405);
}

$db = beam_db();
agent_tables($db);
agent_cleanup($db);
$in = beam_input();
$action = $in['action'] ?? '';
$now = time();

switch ($action) {
    case 'create': {
        $live = (int)$db->query('SELECT COUNT(*) FROM agent_rooms WHERE (created + ttl) >= ' . $now)->fetchColumn();
        if ($live > AGENT_MAX_LIVE) agent_err('busy', 503);

        $ttl = (int)($in['ttl'] ?? AGENT_DEFAULT_TTL);
        $ttl = max(AGENT_MIN_TTL, min(AGENT_MAX_TTL, $ttl));
        $observable = !empty($in['observable']);

        $uniq = function (PDO $db): ?string {
            for ($i = 0; $i < 10; $i++) {
                $try = beam_new_code();
                $c = $db->prepare('SELECT 1 FROM agent_rooms WHERE code = ? OR obs_code = ?');
                $c->execute([$try, $try]);
                if ($c->fetchColumn() === false) return $try;
            }
            return null;
        };
        $code = $uniq($db);
        if ($code === null) agent_err('busy', 503);
        $obsCode = null;
        if ($observable) {
            do { $obsCode = $uniq($db); } while ($obsCode === $code);
            if ($obsCode === null) agent_err('busy', 503);
        }

        $token = agent_token();
        $db->prepare('INSERT INTO agent_rooms (code, obs_code, created, ttl, observable, ended) VALUES (?,?,?,?,?,0)')
           ->execute([$code, $obsCode, $now, $ttl, $observable ? 1 : 0]);
        $db->prepare('INSERT INTO agent_peers (code, peer, role, token_hash, joined, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
           ->execute([$code, 'h', 'host', hash('sha256', $token), $now, $now]);
        beam_count($db, 'agent_created');
        beam_json([
            'ok' => true, 'code' => $code, 'peer' => 'h', 'token' => $token,
            'kind' => 'agent', 'ttl' => $ttl, 'maxGuests' => AGENT_MAX_MEMBERS,
            'observable' => $observable, 'observerCode' => $obsCode,
            'expires_in' => $ttl,
        ]);
    }

    case 'join': {
        $code = beam_valid_code($in['code'] ?? null);
        if ($code === null) agent_err('malformed', 400);
        [$r, $isObs] = agent_resolve($db, $code);
        if (!agent_room_alive($r)) { usleep(300000); agent_err($r ? 'expired' : 'unknown_room', 404); }
        $roomCode = $r['code'];

        if ($isObs) { $role = 'observer'; $prefix = 'o'; $cap = AGENT_MAX_OBSERVERS; }
        else        { $role = 'member';   $prefix = 'g'; $cap = AGENT_MAX_MEMBERS; }

        $c = $db->prepare('SELECT COUNT(*) FROM agent_peers WHERE code = ? AND role = ?');
        $c->execute([$roomCode, $role]);
        $n = (int)$c->fetchColumn();
        // Close reads before writing: an open cursor pins an old WAL snapshot and the
        // INSERT below then fails at once with "database is locked" under concurrency.
        $c->closeCursor();
        if ($n >= $cap) agent_err('room_full', 409);

        $peer = null;
        for ($i = 0; $i < 10; $i++) {
            $try = $prefix . beam_new_code(4);
            $chk = $db->prepare('SELECT 1 FROM agent_peers WHERE code = ? AND peer = ?');
            $chk->execute([$roomCode, $try]);
            $taken = $chk->fetchColumn() !== false;
            $chk->closeCursor();
            if (!$taken) { $peer = $try; break; }
        }
        if ($peer === null) agent_err('busy', 503);

        $token = agent_token();
        $db->prepare('INSERT INTO agent_peers (code, peer, role, token_hash, joined, last_seen) VALUES (?,?,?,?,?,?)')
           ->execute([$roomCode, $peer, $role, hash('sha256', $token), $now, $now]);
        beam_count($db, 'agent_joined');
        beam_json([
            'ok' => true, 'peer' => $peer, 'token' => $token, 'role' => $role,
            'observable' => (int)$r['observable'] === 1,
            'expires_in' => (int)$r['created'] + (int)$r['ttl'] - $now,
        ]);
    }

    case 'signal': {
        $code = beam_valid_code($in['code'] ?? null);
        $peer = agent_valid_peer($in['peer'] ?? null);
        $to   = agent_valid_target($in['to'] ?? null);
        $body = $in['body'] ?? null;
        if ($code === null || $peer === null || $to === null
            || !is_string($body) || strlen($body) > AGENT_MSG_MAX) {
            agent_err('malformed', 400);
        }
        [$r, ] = agent_resolve($db, $code);
        if (!agent_room_alive($r)) agent_err($r ? 'expired' : 'unknown_room', 404);
        $roomCode = $r['code'];

        $role = agent_auth($db, $roomCode, $peer, $in['token'] ?? null);
        if ($role === null) agent_err('bad_token', 401);
        if ($role === 'observer') agent_err('not_permitted', 403); // observers are read-only

        // a specific target must actually be in the room (broadcast skips this)
        if ($to !== 'room') {
            $chk = $db->prepare('SELECT role FROM agent_peers WHERE code = ? AND peer = ?');
            $chk->execute([$roomCode, $to]);
            $trole = $chk->fetchColumn();
            $chk->closeCursor(); // before the INSERT below (see join)
            if ($trole === false) agent_err('unknown_peer', 404);
            if ($trole === 'observer') agent_err('not_permitted', 403); // observers are not addressable
        }

        // sender is the AUTHENTICATED peer — never a client-asserted "from"
        $db->prepare('INSERT INTO agent_msgs (code, sender, target, body, created) VALUES (?,?,?,?,?)')
           ->execute([$roomCode, $peer, $to, $body, $now]);
        $db->prepare('UPDATE agent_peers SET last_seen = ? WHERE code = ? AND peer = ?')
           ->execute([$now, $roomCode, $peer]);
        beam_json(['ok' => true, 'id' => (int)$db->lastInsertId()]);
    }

    case 'poll': {
        $code = beam_valid_code($in['code'] ?? null);
        $peer = agent_valid_peer($in['peer'] ?? null);
        $after = (int)($in['after'] ?? 0);
        if ($code === null || $peer === null) agent_err('malformed', 400);
        [$r, ] = agent_resolve($db, $code);
        if (!agent_room_alive($r)) agent_err($r ? 'expired' : 'unknown_room', 404);
        $roomCode = $r['code'];

        $role = agent_auth($db, $roomCode, $peer, $in['token'] ?? null);
        if ($role === null) agent_err('bad_token', 401);
        $db->prepare('UPDATE agent_peers SET last_seen = ? WHERE code = ? AND peer = ?')
           ->execute([$now, $roomCode, $peer]);

        // delivery predicate: observers see everything; everyone else sees
        // messages addressed to them or to the room, never their own.
        $fetch = function () use ($db, $roomCode, $role, $peer, &$after) {
            if ($role === 'observer') {
                $st = $db->prepare('SELECT id, sender, target AS "to", body FROM agent_msgs
                                    WHERE code = ? AND id > ? ORDER BY id LIMIT 200');
                $st->execute([$roomCode, $after]);
            } else {
                $st = $db->prepare('SELECT id, sender, target AS "to", body FROM agent_msgs
                                    WHERE code = ? AND id > ? AND sender != ?
                                      AND (target = ? OR target = ?) ORDER BY id LIMIT 200');
                $st->execute([$roomCode, $after, $peer, $peer, 'room']);
            }
            return $st->fetchAll(PDO::FETCH_ASSOC);
        };

        $msgs = $fetch();
        // long-poll: hold briefly for messages instead of hammering with polls
        $wait = min(AGENT_WAIT_MAX, max(0, (int)($in['wait_ms'] ?? 0)));
        if (!$msgs && $wait > 0) {
            $deadline = microtime(true) + $wait / 1000;
            while (microtime(true) < $deadline) {
                usleep(1000000);
                [$r2, ] = agent_resolve($db, $roomCode);
                if (!agent_room_alive($r2)) break;
                $msgs = $fetch();
                if ($msgs) break;
            }
        }

        beam_json([
            'ok' => true,
            'msgs' => $msgs,
            'peers' => agent_roster($db, $roomCode),
            'role' => $role,
            'ended' => (int)$r['ended'] === 1,
            'expires_in' => (int)$r['created'] + (int)$r['ttl'] - time(),
        ]);
    }

    case 'end': {
        $code = beam_valid_code($in['code'] ?? null);
        $peer = agent_valid_peer($in['peer'] ?? null);
        if ($code === null || $peer === null) agent_err('malformed', 400);
        [$r, ] = agent_resolve($db, $code);
        if ($r === null) agent_err('unknown_room', 404);
        $roomCode = $r['code'];
        $role = agent_auth($db, $roomCode, $peer, $in['token'] ?? null);
        if ($role === null) agent_err('bad_token', 401);
        if ($role !== 'host') agent_err('not_permitted', 403);
        $db->prepare('UPDATE agent_rooms SET ended = 1 WHERE code = ?')->execute([$roomCode]);
        beam_json(['ok' => true]);
    }

    default:
        agent_err('unknown_action', 400);
}
