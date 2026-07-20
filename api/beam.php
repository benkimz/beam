<?php
// Beam session signaling: pairs devices and relays WebRTC handshake messages.
// One host per beam, up to MAX_GUESTS guests. Every message is addressed
// from one peer id to another ('h' for the host, 'gXXXX' for guests).
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
        $live = (int)$db->query('SELECT COUNT(*) FROM sessions WHERE created >= ' . (time() - SESSION_TTL))->fetchColumn();
        if ($live > 2000) {
            beam_json(['error' => 'beam is busy right now — try again in a minute'], 503);
        }
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
        $db->prepare('DELETE FROM msgs WHERE code = ?')->execute([$code]);
        $db->prepare('INSERT INTO sessions (code, created, host_seen, guests) VALUES (?, ?, ?, 0)')
           ->execute([$code, $now, $now]);
        beam_count($db, 'beam_created');
        beam_json(['code' => $code, 'ttl' => SESSION_TTL, 'maxGuests' => MAX_GUESTS]);
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
        // atomic slot claim: two simultaneous joins can't both take the last seat
        $st = $db->prepare('UPDATE sessions SET guests = guests + 1, guest_seen = ?
                            WHERE code = ? AND guests < ' . MAX_GUESTS);
        $st->execute([$now, $code]);
        if ($st->rowCount() === 0) {
            beam_json(['error' => 'This beam is full — up to ' . MAX_GUESTS . ' devices can join.'], 409);
        }
        $peer = 'g' . beam_new_code(4);
        beam_count($db, 'beam_joined');
        beam_json(['ok' => true, 'peer' => $peer]);
    }

    case 'signal': {
        $code = beam_valid_code($in['code'] ?? null);
        $from = beam_valid_peer($in['from'] ?? null);
        $to = beam_valid_peer($in['to'] ?? null);
        $body = $in['body'] ?? null;
        if ($code === null || $from === null || $to === null
            || !is_string($body) || strlen($body) > SIGNAL_MAX_BYTES) {
            beam_json(['error' => 'bad request'], 400);
        }
        if (beam_session($db, $code) === null) {
            beam_json(['error' => 'expired'], 404);
        }
        $db->prepare('INSERT INTO msgs (code, sender, target, body, created) VALUES (?, ?, ?, ?, ?)')
           ->execute([$code, $from, $to, $body, $now]);
        beam_json(['ok' => true]);
    }

    case 'poll': {
        $code = beam_valid_code($in['code'] ?? null);
        $peer = beam_valid_peer($in['peer'] ?? null);
        $after = (int)($in['after'] ?? 0);
        if ($code === null || $peer === null) {
            beam_json(['error' => 'bad request'], 400);
        }
        $s = beam_session($db, $code);
        if ($s === null) {
            beam_json(['error' => 'expired'], 404);
        }
        $col = $peer === 'h' ? 'host_seen' : 'guest_seen';
        $db->prepare("UPDATE sessions SET $col = ? WHERE code = ?")->execute([$now, $code]);
        $st = $db->prepare('SELECT id, sender, body FROM msgs WHERE code = ? AND target = ? AND id > ? ORDER BY id LIMIT 50');
        $st->execute([$code, $peer, $after]);
        $msgs = $st->fetchAll(PDO::FETCH_ASSOC);
        beam_json(['msgs' => $msgs, 'guests' => (int)($s['guests'] ?? 0)]);
    }

    default:
        beam_json(['error' => 'unknown action'], 400);
}
