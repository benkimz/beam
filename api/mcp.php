<?php
// Remote MCP server (Streamable HTTP transport) for the beam agent bus.
// Lets a claude.ai custom connector — or any remote MCP client — join beam agent
// rooms as tools. Proxies tool calls to agent.php and keeps each MCP session's
// room tokens server-side (keyed by Mcp-Session-Id), so the model never handles
// secrets. Additive: touches nothing else.
declare(strict_types=1);
require __DIR__ . '/_lib.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization');
header('Access-Control-Expose-Headers: Mcp-Session-Id');

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') { http_response_code(204); exit; }
if ($method === 'GET') {
    // No server-initiated SSE stream; spec-compliant to answer 405.
    http_response_code(405);
    header('Allow: POST');
    header('Content-Type: application/json');
    echo json_encode(['jsonrpc' => '2.0', 'error' => ['code' => -32000,
        'message' => 'beam MCP: POST JSON-RPC to this endpoint (Streamable HTTP).']]);
    exit;
}
if ($method !== 'POST') { http_response_code(405); exit; }

$db = beam_db();
$db->exec('CREATE TABLE IF NOT EXISTS mcp_state (
    sid TEXT NOT NULL,
    code TEXT NOT NULL,
    peer TEXT NOT NULL,
    token TEXT NOT NULL,
    role TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    PRIMARY KEY (sid, code)
)');
if (random_int(0, 9) === 0) {
    $db->prepare('DELETE FROM mcp_state WHERE created < ?')->execute([time() - 90000]); // 25h
}

$sid = $_SERVER['HTTP_MCP_SESSION_ID'] ?? '';

$raw = file_get_contents('php://input');
$parsed = json_decode($raw === false ? '' : $raw, true);
if (!is_array($parsed)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'Parse error']]);
    exit;
}

// ---- helpers ----
function rpc_result($id, $result): array { return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]; }
function rpc_error($id, int $code, string $msg): array {
    return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $msg]];
}
function tool_text($text, bool $isError = false): array {
    $t = is_string($text) ? $text : json_encode($text, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    $r = ['content' => [['type' => 'text', 'text' => $t]]];
    if ($isError) $r['isError'] = true;
    return $r;
}

// Call agent.php internally over loopback and return [status, decoded].
function agent_call(array $payload): array {
    $ch = curl_init('https://beamtm.com/api/agent.php');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 25,
    ]);
    $out = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $d = json_decode($out === false ? '' : $out, true);
    return [$status, is_array($d) ? $d : []];
}

function mcp_tools(): array {
    return [
        ['name' => 'beam_create_room',
         'description' => 'Create a durable beam agent room to collaborate with AI sessions on other machines. Returns a short code to share. Rooms survive sleep/idle and last for their lifetime (default 4h). Set observable to also get a read-only observer code a human can use to watch.',
         'inputSchema' => ['type' => 'object', 'properties' => [
             'ttl_hours' => ['type' => 'number', 'description' => 'Room lifetime in hours (default 4, max 24).'],
             'observable' => ['type' => 'boolean', 'description' => 'Also return a read-only observer code.']]]],
        ['name' => 'beam_join_room',
         'description' => 'Join an existing beam agent room by its code (or watch read-only with an observer code). Share your own code with the other session so they can join.',
         'inputSchema' => ['type' => 'object', 'properties' => [
             'code' => ['type' => 'string', 'description' => 'The 6-character room code.']], 'required' => ['code']]],
        ['name' => 'beam_send',
         'description' => 'Send a text message in a room you have joined. "to" is "room" for everyone (default), "h" for the host, or a peer id from the roster.',
         'inputSchema' => ['type' => 'object', 'properties' => [
             'code' => ['type' => 'string'], 'message' => ['type' => 'string'],
             'to' => ['type' => 'string', 'description' => '"room" (default), "h", or a peer id.']], 'required' => ['code', 'message']]],
        ['name' => 'beam_receive',
         'description' => 'Check for new messages in a room. Waits up to wait_seconds for one to arrive (long-poll). Returns new messages since your last check, plus the roster.',
         'inputSchema' => ['type' => 'object', 'properties' => [
             'code' => ['type' => 'string'], 'wait_seconds' => ['type' => 'number', 'description' => '0-15, default 10.']], 'required' => ['code']]],
        ['name' => 'beam_roster',
         'description' => 'List who is in a room (peer ids and roles: host, member, observer).',
         'inputSchema' => ['type' => 'object', 'properties' => ['code' => ['type' => 'string']], 'required' => ['code']]],
        ['name' => 'beam_end',
         'description' => 'End a room for everyone (host only).',
         'inputSchema' => ['type' => 'object', 'properties' => ['code' => ['type' => 'string']], 'required' => ['code']]],
    ];
}

function call_tool(string $name, array $a, string $sid, PDO $db) {
    if ($sid === '') return tool_text('Session not initialized — reconnect the connector.', true);
    $findRoom = function (string $code) use ($sid, $db) {
        $st = $db->prepare('SELECT peer, token, role, cursor FROM mcp_state WHERE sid = ? AND code = ?');
        $st->execute([$sid, $code]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r === false ? null : $r;
    };

    switch ($name) {
        case 'beam_create_room': {
            $ttl = (int) round((($a['ttl_hours'] ?? 4)) * 3600);
            [$st, $d] = agent_call(['action' => 'create', 'ttl' => $ttl, 'observable' => !empty($a['observable'])]);
            if ($st !== 200 || empty($d['code'])) return tool_text('Could not create room: ' . ($d['error'] ?? $st), true);
            $db->prepare('INSERT OR REPLACE INTO mcp_state (sid, code, peer, token, role, cursor, created) VALUES (?,?,?,?,?,0,?)')
               ->execute([$sid, $d['code'], 'h', $d['token'], 'host', time()]);
            return tool_text([
                'code' => $d['code'],
                'observer_code' => $d['observerCode'] ?? null,
                'your_role' => 'host',
                'expires_in_hours' => round(($d['expires_in'] ?? 0) / 3600, 2),
                'next' => 'Share the code "' . $d['code'] . '" with the other session. Use beam_receive to listen.',
            ]);
        }
        case 'beam_join_room': {
            $code = strtoupper(trim((string) ($a['code'] ?? '')));
            [$st, $d] = agent_call(['action' => 'join', 'code' => $code]);
            if ($st !== 200 || empty($d['peer'])) return tool_text('Could not join ' . $code . ': ' . ($d['error'] ?? $st), true);
            $db->prepare('INSERT OR REPLACE INTO mcp_state (sid, code, peer, token, role, cursor, created) VALUES (?,?,?,?,?,0,?)')
               ->execute([$sid, $code, $d['peer'], $d['token'], $d['role'], time()]);
            return tool_text([
                'code' => $code, 'your_peer_id' => $d['peer'], 'your_role' => $d['role'],
                'expires_in_hours' => round(($d['expires_in'] ?? 0) / 3600, 2),
                'next' => 'Use beam_send to talk and beam_receive to listen.',
            ]);
        }
        case 'beam_send': {
            $code = strtoupper(trim((string) ($a['code'] ?? '')));
            $room = $findRoom($code);
            if (!$room) return tool_text('Not in room ' . $code . ' — join it first with beam_join_room.', true);
            $body = base64_encode(json_encode(['text' => (string) ($a['message'] ?? '')]));
            [$st, $d] = agent_call(['action' => 'signal', 'code' => $code, 'peer' => $room['peer'],
                'token' => $room['token'], 'to' => $a['to'] ?? 'room', 'body' => $body]);
            if ($st !== 200) return tool_text('Send failed: ' . ($d['error'] ?? $st), true);
            return tool_text(['sent' => true, 'id' => $d['id'] ?? null, 'to' => $a['to'] ?? 'room']);
        }
        case 'beam_receive': {
            $code = strtoupper(trim((string) ($a['code'] ?? '')));
            $room = $findRoom($code);
            if (!$room) return tool_text('Not in room ' . $code . ' — join it first.', true);
            $wait = max(0, min(15, (int) ($a['wait_seconds'] ?? 10))) * 1000;
            [$st, $d] = agent_call(['action' => 'poll', 'code' => $code, 'peer' => $room['peer'],
                'token' => $room['token'], 'after' => (int) $room['cursor'], 'wait_ms' => $wait]);
            if ($st === 404) return tool_text(['room_ended' => true, 'messages' => []]);
            if ($st !== 200) return tool_text('Receive failed: ' . ($d['error'] ?? $st), true);
            $cursor = (int) $room['cursor'];
            $msgs = [];
            foreach ($d['msgs'] ?? [] as $m) {
                $cursor = max($cursor, (int) $m['id']);
                $dec = json_decode(base64_decode((string) $m['body']) ?: '', true);
                $msgs[] = ['from' => $m['sender'], 'to' => $m['to'],
                    'text' => is_array($dec) && isset($dec['text']) ? $dec['text'] : (string) $m['body']];
            }
            $db->prepare('UPDATE mcp_state SET cursor = ? WHERE sid = ? AND code = ?')->execute([$cursor, $sid, $code]);
            $roster = array_map(fn($p) => $p['peer'] . ':' . $p['role'], $d['peers'] ?? []);
            return tool_text([
                'messages' => $msgs, 'roster' => $roster,
                'expires_in_hours' => round(($d['expires_in'] ?? 0) / 3600, 2),
            ]);
        }
        case 'beam_roster': {
            $code = strtoupper(trim((string) ($a['code'] ?? '')));
            $room = $findRoom($code);
            if (!$room) return tool_text('Not in room ' . $code . '.', true);
            [$st, $d] = agent_call(['action' => 'poll', 'code' => $code, 'peer' => $room['peer'], 'token' => $room['token'], 'after' => 999999999]);
            if ($st !== 200) return tool_text('Roster failed: ' . ($d['error'] ?? $st), true);
            return tool_text(['roster' => array_map(fn($p) => $p['peer'] . ':' . $p['role'], $d['peers'] ?? [])]);
        }
        case 'beam_end': {
            $code = strtoupper(trim((string) ($a['code'] ?? '')));
            $room = $findRoom($code);
            if (!$room) return tool_text('Not in room ' . $code . '.', true);
            [$st, $d] = agent_call(['action' => 'end', 'code' => $code, 'peer' => $room['peer'], 'token' => $room['token']]);
            return tool_text(['ended' => $st === 200]);
        }
        default:
            return tool_text('Unknown tool: ' . $name, true);
    }
}

// ---- dispatch ----
$isBatch = array_is_list($parsed) && $parsed !== [];
$requests = $isBatch ? $parsed : [$parsed];
$responses = [];
$newSid = null;

foreach ($requests as $r) {
    if (!is_array($r)) continue;
    $id = $r['id'] ?? null;
    $m = (string) ($r['method'] ?? '');

    if ($m === '' && $id === null) continue;
    if (str_starts_with($m, 'notifications/')) continue; // notifications get no response

    switch ($m) {
        case 'initialize': {
            $newSid = bin2hex(random_bytes(16));
            $pv = $r['params']['protocolVersion'] ?? '2025-06-18';
            $responses[] = rpc_result($id, [
                'protocolVersion' => $pv,
                'capabilities' => ['tools' => new stdClass()],
                'serverInfo' => ['name' => 'beam-agent', 'version' => '1.0.0'],
                'instructions' => 'Connect AI sessions across machines over the beam agent bus. Create or join a room by code, then send/receive text. Tokens are handled for you.',
            ]);
            break;
        }
        case 'ping': $responses[] = rpc_result($id, new stdClass()); break;
        case 'tools/list': $responses[] = rpc_result($id, ['tools' => mcp_tools()]); break;
        case 'tools/call': {
            $params = $r['params'] ?? [];
            try {
                $responses[] = rpc_result($id, call_tool((string) ($params['name'] ?? ''), $params['arguments'] ?? [], $sid, $db));
            } catch (Throwable $e) {
                $responses[] = rpc_result($id, tool_text('beam error: ' . $e->getMessage(), true));
            }
            break;
        }
        default:
            if ($id !== null) $responses[] = rpc_error($id, -32601, 'Method not found: ' . $m);
    }
}

if ($newSid !== null) header('Mcp-Session-Id: ' . $newSid);
header('Content-Type: application/json');
header('Cache-Control: no-store');
if (!$responses) { http_response_code(202); exit; }
echo json_encode($isBatch ? $responses : $responses[0]);
