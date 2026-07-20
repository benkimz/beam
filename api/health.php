<?php
// Deployment probe — reports server capabilities.
// Gated by a key stored server-side in <data dir>/probe_key.txt (not in the repo);
// if that file is absent the probe is disabled entirely.
declare(strict_types=1);
header('Content-Type: application/json');
header('Cache-Control: no-store');

$keyFile = dirname(__DIR__, 2) . '/beamtm_data/probe_key.txt';
$expected = is_file($keyFile) ? trim((string)file_get_contents($keyFile)) : '';
if ($expected === '' || !hash_equals($expected, (string)($_GET['k'] ?? ''))) {
    http_response_code(404);
    echo '{"error":"not found"}';
    exit;
}

$dataDir = dirname(__DIR__, 2) . '/beamtm_data';
$dirOk = is_dir($dataDir) || @mkdir($dataDir, 0700, true);
$writeOk = false;
$sqliteOk = false;
$sqliteVersion = null;

if ($dirOk) {
    $t = @file_put_contents($dataDir . '/probe.txt', 'ok');
    $writeOk = ($t !== false);
    if ($writeOk) @unlink($dataDir . '/probe.txt');
    try {
        $db = new PDO('sqlite:' . $dataDir . '/probe.db');
        $db->exec('CREATE TABLE IF NOT EXISTS t (x INT)');
        $sqliteVersion = $db->query('SELECT sqlite_version()')->fetchColumn();
        $sqliteOk = true;
        $db = null;
        @unlink($dataDir . '/probe.db');
    } catch (Throwable $e) {
        $sqliteOk = false;
    }
}

echo json_encode([
    'php' => PHP_VERSION,
    'pdo_sqlite' => extension_loaded('pdo_sqlite'),
    'sqlite_works' => $sqliteOk,
    'sqlite_version' => $sqliteVersion,
    'openssl' => extension_loaded('openssl'),
    'data_dir' => $dataDir,
    'data_dir_ok' => $dirOk,
    'data_dir_writable' => $writeOk,
    'upload_max_filesize' => ini_get('upload_max_filesize'),
    'post_max_size' => ini_get('post_max_size'),
    'memory_limit' => ini_get('memory_limit'),
    'max_execution_time' => ini_get('max_execution_time'),
]);
