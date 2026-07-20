<?php
// Store-and-forward fallback for when a direct P2P connection can't be made.
// One file per beam session, deleted on download or after session TTL.
declare(strict_types=1);
require __DIR__ . '/_lib.php';

$relayDir = beam_data_dir() . '/relay';
if (!is_dir($relayDir)) {
    @mkdir($relayDir, 0700, true);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $code = beam_valid_code($_SERVER['HTTP_X_BEAM_CODE'] ?? null);
    $name = $_SERVER['HTTP_X_BEAM_NAME'] ?? 'beamed-file';
    $db = beam_db();
    if ($code === null || beam_session($db, $code) === null) {
        beam_json(['error' => 'Beam expired — start a new one.'], 404);
    }
    $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len <= 0 || $len > RELAY_MAX_BYTES) {
        beam_json(['error' => 'Relay files are limited to ' . (int)(RELAY_MAX_BYTES / 1048576) . ' MB. Direct beams have no limit.'], 413);
    }
    $in = fopen('php://input', 'rb');
    $out = fopen("$relayDir/$code.bin", 'wb');
    if ($in === false || $out === false) {
        beam_json(['error' => 'server storage error'], 500);
    }
    $written = stream_copy_to_stream($in, $out, RELAY_MAX_BYTES + 1);
    fclose($in);
    fclose($out);
    if ($written > RELAY_MAX_BYTES) {
        @unlink("$relayDir/$code.bin");
        beam_json(['error' => 'too large'], 413);
    }
    $name = mb_substr(preg_replace('/[\x00-\x1f\/\\\\]/', '_', $name), 0, 180);
    file_put_contents("$relayDir/$code.json", json_encode(['name' => $name, 'size' => $written]));
    beam_json(['ok' => true, 'size' => $written]);
}

if ($method === 'GET') {
    $code = beam_valid_code($_GET['code'] ?? null);
    if ($code === null || !is_file("$relayDir/$code.bin")) {
        beam_json(['error' => 'nothing waiting'], 404);
    }
    $meta = json_decode((string)file_get_contents("$relayDir/$code.json"), true) ?: ['name' => 'beamed-file'];
    $size = filesize("$relayDir/$code.bin");
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . $size);
    header('Content-Disposition: attachment; filename="' . rawurlencode($meta['name']) . '"');
    header('Cache-Control: no-store');
    readfile("$relayDir/$code.bin");
    @unlink("$relayDir/$code.bin");
    @unlink("$relayDir/$code.json");
    exit;
}

beam_json(['error' => 'method not allowed'], 405);
