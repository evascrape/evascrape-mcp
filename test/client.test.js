/** Client safety: the key only goes over HTTPS and never appears in error text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvascrapeClient, resolveBaseUrl } from '../src/client.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

test('base URL: https required, plain http only for localhost', () => {
  assert.equal(resolveBaseUrl(undefined), 'https://app.evascrape.com');
  assert.equal(resolveBaseUrl('https://app.evascrape.com/'), 'https://app.evascrape.com');
  assert.equal(resolveBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of ['http://app.evascrape.com', 'ftp://x', 'not a url', 'https://u:p@app.evascrape.com', 'https://app.evascrape.com/?a=1']) {
    assert.throws(() => resolveBaseUrl(bad), /EVASCRAPE_BASE_URL/, bad);
  }
});

test('server refuses to start with an insecure base URL and does not print the key', () => {
  const r = spawnSync(process.execPath, [ENTRY], {
    env: { ...process.env, EVASCRAPE_API_KEY: 'evs_live_SECRETSECRET', EVASCRAPE_BASE_URL: 'http://evil.example' },
    input: '', encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must use https/);
  assert.doesNotMatch(r.stderr + r.stdout, /SECRETSECRET/);
});

test('without a key no request is sent and the error says where to get one', async () => {
  const c = new EvascrapeClient({ apiKey: '', baseUrl: 'http://127.0.0.1:9' });
  await assert.rejects(c.balance(), /api-keys/);
});

test('a key echoed in an API error is redacted', async () => {
  const key = 'evs_live_ECHOECHOECHO';
  const srv = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `bad key ${req.headers.authorization}` } }));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const c = new EvascrapeClient({ apiKey: key, baseUrl: `http://127.0.0.1:${srv.address().port}` });
    await assert.rejects(c.balance(), (err) => {
      assert.equal(err.status, 401);
      assert.doesNotMatch(err.message, /ECHOECHO/);
      assert.match(err.message, /\[redacted\]/);
      return true;
    });
  } finally { await new Promise((r) => srv.close(r)); }
});
