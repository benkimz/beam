<?php
// Self-destructing secrets. Stores ciphertext only — encryption/decryption
// happen in the browser and the key never reaches this server.
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
        $ct = $in['ct'] ?? null;
        $ttl = (int)($in['ttl'] ?? SECRET_DEFAULT_TTL);
        if (!is_string($ct) || $ct === '' || strlen($ct) > SECRET_MAX_BYTES) {
            beam_json(['error' => 'Secret is empty or too large (64 KB max).'], 400);
        }
        if (preg_match('/^[A-Za-z0-9+\/=_-]+$/', $ct) !== 1) {
            beam_json(['error' => 'bad payload'], 400);
        }
        $ttl = max(300, min(SECRET_MAX_TTL, $ttl));
        $id = rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
        $db->prepare('INSERT INTO secrets (id, ct, created, expires) VALUES (?, ?, ?, ?)')
           ->execute([$id, $ct, $now, $now + $ttl]);
        beam_json(['id' => $id, 'expires' => $now + $ttl]);
    }

    case 'read': {
        $id = $in['id'] ?? null;
        if (!is_string($id) || preg_match('/^[A-Za-z0-9_-]{8,24}$/', $id) !== 1) {
            beam_json(['error' => 'bad request'], 400);
        }
        // Read-and-burn atomically so two simultaneous readers can't both win.
        $db->exec('BEGIN IMMEDIATE');
        try {
            $st = $db->prepare('SELECT ct, expires FROM secrets WHERE id = ?');
            $st->execute([$id]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            $db->prepare('DELETE FROM secrets WHERE id = ?')->execute([$id]);
            $db->exec('COMMIT');
        } catch (Throwable $e) {
            $db->exec('ROLLBACK');
            beam_json(['error' => 'busy'], 503);
        }
        if ($row === false || (int)$row['expires'] < $now) {
            usleep(300000);
            beam_json(['gone' => true], 404);
        }
        beam_json(['ct' => $row['ct']]);
    }

    default:
        beam_json(['error' => 'unknown action'], 400);
}
