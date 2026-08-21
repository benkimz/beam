// Static checks that need no running server: specs parse, client JS is valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('OpenAPI specs are valid JSON', () => {
  JSON.parse(readFileSync('api/openapi.json', 'utf8'));
  JSON.parse(readFileSync('api/agent-openapi.json', 'utf8'));
});

test('client and MCP JavaScript parses without syntax errors', () => {
  for (const f of ['assets/app.js', 'assets/qr.js', 'agent/beam-agent.mjs', 'agent/mcp/server.mjs']) {
    // `node --check` throws on a syntax error; passing means the file parses.
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }
});

test('the homepage embeds valid FAQ and app structured data', () => {
  const html = readFileSync('index.html', 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 2, 'homepage has JSON-LD blocks');
  for (const b of blocks) JSON.parse(b[1].trim());
});
