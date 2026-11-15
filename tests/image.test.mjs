// Hardening of the Docker image: php.ini values in effect, no root processes,
// nothing written outside the data volume. Needs the docker CLI and the running
// container's name: set BEAM_CONTAINER (CI's docker job sets it to "beam").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { BASE } from './helpers.mjs';

const C = process.env.BEAM_CONTAINER;
const skip = !C && 'set BEAM_CONTAINER to the running image to run image tests';
const sh = (cmd) => execFileSync('docker', ['exec', C, 'sh', '-c', cmd], { encoding: 'utf8' });

test('php.ini hardening is in effect', { skip }, () => {
  // The CLI reads the same php.ini + conf.d as mod_php.
  const ini = JSON.parse(sh(`php -r 'echo json_encode([
    "disable_functions" => ini_get("disable_functions"), "open_basedir" => ini_get("open_basedir"),
    "allow_url_fopen" => ini_get("allow_url_fopen"), "allow_url_include" => ini_get("allow_url_include"),
    "expose_php" => ini_get("expose_php"), "display_errors" => ini_get("display_errors"),
    "log_errors" => ini_get("log_errors"), "post_max_size" => ini_get("post_max_size"),
    "exec" => function_exists("exec"), "curl" => function_exists("curl_init")]);'`));
  const disabled = ini.disable_functions.split(',').map((s) => s.trim());
  for (const f of ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen', 'pcntl_exec']) {
    assert.ok(disabled.includes(f), `${f} disabled`);
  }
  assert.equal(ini.exec, false, 'exec() is not callable');
  assert.equal(ini.curl, true, 'curl stays available for the mcp loopback');
  assert.equal(ini.open_basedir, '/var/www/beam/public:/var/www/beam/beamtm_data:/tmp');
  assert.equal(ini.allow_url_fopen, '');
  assert.equal(ini.allow_url_include, '');
  assert.equal(ini.expose_php, '');
  assert.ok(['', '0', 'Off'].includes(ini.display_errors), `display_errors=${ini.display_errors}`);
  assert.equal(ini.log_errors, '1');
  assert.equal(ini.post_max_size, '10M');
});

test('Apache/mod_php hides the PHP version header (expose_php=Off)', { skip }, async () => {
  const r = await fetch(`${BASE}/api/agent.php`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('no process in the container runs as root', { skip }, () => {
  const uids = sh("awk '/^Uid:/{print $2}' /proc/[0-9]*/status").trim().split(/\s+/);
  assert.ok(uids.length > 1, 'saw processes');
  assert.ok(!uids.includes('0'), `uids: ${[...new Set(uids)].join(',')}`);
});

test('the docroot is not writable by the web user', { skip }, () => {
  assert.equal(sh('test -w /var/www/beam/public/api && echo yes || echo no').trim(), 'no');
  assert.equal(sh('test -w /var/www/beam/beamtm_data && echo yes || echo no').trim(), 'yes');
});

test('a 7 MB relay upload fits the PHP limits and is stored outside the docroot', { skip }, async () => {
  const XFP = { 'X-Forwarded-Proto': 'https' };
  const create = await fetch(`${BASE}/api/beam.php`, { method: 'POST', headers: { ...XFP, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create' }) });
  const { code } = await create.json();
  const body = Buffer.alloc(7 * 1048576, 7);
  const up = await fetch(`${BASE}/api/relay.php`, { method: 'POST', body,
    headers: { ...XFP, 'Content-Type': 'application/octet-stream', 'X-Beam-Code': code, 'X-Beam-Name': 'big.bin' } });
  assert.equal(up.status, 200, await up.clone().text());
  assert.equal((await up.json()).size, body.length);
  assert.equal(sh(`test -f /var/www/beam/beamtm_data/relay/${code}.bin && echo yes`).trim(), 'yes');
  assert.equal(sh(`find /var/www/beam/public -name '${code}*' | wc -l`).trim(), '0', 'nothing written inside the docroot');
  const down = await fetch(`${BASE}/api/relay.php?code=${code}`, { headers: XFP });
  assert.equal(down.status, 200);
  assert.equal(Buffer.from(await down.arrayBuffer()).length, body.length);
});

test('health.php requests (probe key in the query) never reach the access log', { skip }, async () => {
  const mark = `m${Date.now()}`;
  const XFP = { 'X-Forwarded-Proto': 'https' };
  await fetch(`${BASE}/api/health.php?k=secret-${mark}`, { headers: XFP });
  await fetch(`${BASE}/robots.txt?${mark}`, { headers: XFP });
  await new Promise((r) => setTimeout(r, 500));
  const out = spawnSync('docker', ['logs', C], { encoding: 'utf8' });
  const log = out.stdout + out.stderr; // access log -> stdout, error log -> stderr
  const lines = log.split('\n');
  assert.ok(lines.some((l) => l.includes(`/robots.txt?${mark}`)), 'other requests are logged');
  assert.ok(!lines.some((l) => l.includes('health.php')), 'no access-log line for health.php');
  assert.ok(!log.includes(`secret-${mark}`), 'probe key never logged');
});
