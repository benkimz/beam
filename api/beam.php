<?php
// Beam session signaling: pairs two devices and relays WebRTC handshake messages.
declare(strict_types=1);
require __DIR__ . '/_lib.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    beam_json(['error' => 'POST only'], 405);
}

$in = beam_input();
$action = $in['action'] ?? '';
$db = beam_db();
beam_cleanup($db);
$now = time();

switch ($action) {
    case 'create': {
        $code = null;
        for ($i = 0; $i < 8; $i++) {
            $try = beam_new_code();
            if (beam_session($db, $try) === null) {
                $code = $try;
                break;
            }
        }
        if ($code === null) {
            beam_json(['error' => 'busy, try again'], 503);
        }
        $db->prepare('DELETE FROM sessions WHERE code = ?')->execute([$code]);
        $db->prepare('DELETE FROM signals WHERE code = ?')->execute([$code]);
        $db->prepare('INSERT INTO sessions (code, created, host_seen) VALUES (?, ?, ?)')
           ->execute([$code, $now, $now]);
        beam_json(['code' => $code, 'ttl' => SESSION_TTL]);
    }

    case 'join': {
        $code = beam_valid_code($in['code'] ?? null);
        if ($code === null) {
            beam_json(['error' => 'That code doesn\'t look right — codes are 6 letters and numbers.'], 400);
        }
        $s = beam_session($db, $code);
        if ($s === null) {
            usleep(400000); // slow down code guessing
            beam_json(['error' => 'No beam with that code. It may have expired — beams last 15 minutes.'], 404);
        }
        $db->prepare('UPDATE sessions SET guest_seen = ? WHERE code = ?')->execute([$now, $code]);
        beam_json(['ok' => true]);
    }

    case 'signal': {
        $code = beam_valid_code($in['code'] ?? null);
        $role = ($in['role'] ?? '') === 'h' ? 'h' : 'g';
        $body = $in['body'] ?? null;
        if ($code === null || !is_string($body) || strlen($body) > SIGNAL_MAX_BYTES) {
            beam_json(['error' => 'bad request'], 400);
        }
        if (beam_session($db, $code) === null) {
            beam_json(['error' => 'expired'], 404);
        }
        $db->prepare('INSERT INTO signals (code, sender, body, created) VALUES (?, ?, ?, ?)')
           ->execute([$code, $role, $body, $now]);
        beam_json(['ok' => true]);
    }

    case 'poll': {
        $code = beam_valid_code($in['code'] ?? null);
        $role = ($in['role'] ?? '') === 'h' ? 'h' : 'g';
        $after = (int)($in['after'] ?? 0);
        if ($code === null) {
            beam_json(['error' => 'bad request'], 400);
        }
        $s = beam_session($db, $code);
        if ($s === null) {
            beam_json(['error' => 'expired'], 404);
        }
        $col = $role === 'h' ? 'host_seen' : 'guest_seen';
        $db->prepare("UPDATE sessions SET $col = ? WHERE code = ?")->execute([$now, $code]);
        $st = $db->prepare('SELECT id, body FROM signals WHERE code = ? AND sender != ? AND id > ? ORDER BY id LIMIT 50');
        $st->execute([$code, $role, $after]);
        $msgs = $st->fetchAll(PDO::FETCH_ASSOC);
        beam_json([
            'msgs' => $msgs,
            'peer' => $role === 'h' ? ((int)$s['guest_seen'] > 0) : true,
        ]);
    }

    default:
        beam_json(['error' => 'unknown action'], 400);
}
