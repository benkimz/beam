<?php
// Usage stats. POST = anonymous page-view beacon (aggregate counter only).
// GET with the server-side probe key = read the numbers.
declare(strict_types=1);
require __DIR__ . '/_lib.php';

$db = beam_db();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    beam_count($db, 'page_view');
    beam_json(['ok' => true]);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $keyFile = dirname(__DIR__, 2) . '/beamtm_data/probe_key.txt';
    $expected = is_file($keyFile) ? trim((string)file_get_contents($keyFile)) : '';
    if ($expected === '' || !hash_equals($expected, (string)($_GET['k'] ?? ''))) {
        beam_json(['error' => 'not found'], 404);
    }
    $rows = $db->query('SELECT day, metric, n FROM stats ORDER BY day DESC, metric')
               ->fetchAll(PDO::FETCH_ASSOC);
    $totals = [];
    foreach ($rows as $r) {
        $totals[$r['metric']] = ($totals[$r['metric']] ?? 0) + (int)$r['n'];
    }
    beam_json(['totals' => $totals, 'daily' => $rows]);
}

beam_json(['error' => 'method not allowed'], 405);
