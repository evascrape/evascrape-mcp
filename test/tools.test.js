/**
 * End-to-end test of the MCP server: real stdio protocol, mock Evascrape API.
 * Checks that tools are listed and callable and that errors read well for an agent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'index.js');

let api, baseUrl, client, transport;
const seen = [];

test.before(async () => {
  api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const job = {
        id: 1421, status: 'succeeded', source: 'google_maps', list_name: 'austin-dentists',
        requested_records: 200, delivered_records: 173, records_with_email: 120,
        email_verification: false, verification_status: 'none',
        credits_charged: '2.40', credits_refunded: '0.32', error: null,
        created_at: '2026-09-06T10:00:00.000Z',
        results: { available: true, variants: ['all'], url: '/api/v1/jobs/1421/results' },
      };
      if (req.url === '/api/v1/jobs' && req.method === 'POST') return send(202, { job: { ...job, status: 'queued' } });
      if (req.url === '/api/v1/jobs/1421') return send(200, { job });
      if (req.url.startsWith('/api/v1/jobs/1421/results')) {
        return send(200, {
          job_id: 1421, variant: 'all', total: 173, offset: 0, limit: 1000, has_more: false,
          fields: ['Name', 'Email', 'Phone'],
          records: [{ Name: 'Smile Dental', Email: 'hi@smile.com', Phone: '+1512...' }],
        });
      }
      if (req.url === '/api/v1/balance') return send(200, { credits: '42.10', currency: 'USD' });
      if (req.url === '/api/v1/quote' && req.method === 'POST') {
        return send(200, { source: 'google_maps', total_records: 200, email_verification: false,
          cost: { base: '2.40', verification: '0.00', total: '2.40' }, currency: 'USD', note: 'You are charged up front.' });
      }
      if (req.url === '/api/v1/jobs/999') return send(404, { error: { code: 'not_found', message: 'No job with that id.' } });
      return send(500, { error: { code: 'x', message: 'unexpected' } });
    });
  });
  await new Promise((r) => api.listen(0, r));
  baseUrl = `http://127.0.0.1:${api.address().port}`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, EVASCRAPE_API_KEY: 'evs_live_test', EVASCRAPE_BASE_URL: baseUrl },
  });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  await new Promise((r) => api.close(r));
});

test('lists seven tools, Maps first', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['google_maps_leads', 'apollo_export', 'linkedin_leads', 'job_status', 'download', 'check_balance', 'estimate_cost']);
  const maps = tools.find((t) => t.name === 'google_maps_leads');
  assert.match(maps.description, /dentists in Austin/);
  assert.ok(maps.inputSchema.required.includes('search_terms'));
  assert.ok(maps.inputSchema.required.includes('location'));
  assert.ok(maps.inputSchema.required.includes('total_records'));
});

test('google_maps_leads starts a job and tells the agent the next step', async () => {
  const r = await client.callTool({
    name: 'google_maps_leads',
    arguments: { search_terms: 'dentist', location: 'Austin, Texas', total_records: 200 },
  });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Started job 1421/);
  assert.match(r.content[0].text, /call job_status/);
  const sent = seen.find((s) => s.url === '/api/v1/jobs' && s.method === 'POST');
  assert.equal(sent.auth, 'Bearer evs_live_test');
  assert.equal(sent.body.source, 'google_maps');
  assert.equal(sent.body.list_name, 'dentist-austin-texas');
  assert.equal(sent.body.total_records, 200);
});

test('job_status summarises a finished job', async () => {
  const r = await client.callTool({ name: 'job_status', arguments: { job_id: 1421 } });
  assert.match(r.content[0].text, /is succeeded/);
  assert.match(r.content[0].text, /Delivered 173 of 200/);
  assert.match(r.content[0].text, /120 of them have an email/);
  assert.match(r.content[0].text, /Call download with job_id 1421/);
});

test('download returns fields and rows', async () => {
  const r = await client.callTool({ name: 'download', arguments: { job_id: 1421, limit: 50 } });
  assert.match(r.content[0].text, /1 of 173 records/);
  assert.match(r.content[0].text, /Fields: Name, Email, Phone/);
  assert.equal(r.structuredContent.records[0].Email, 'hi@smile.com');
});

test('check_balance and estimate_cost', async () => {
  const b = await client.callTool({ name: 'check_balance', arguments: {} });
  assert.match(b.content[0].text, /42\.10 USD/);
  const q = await client.callTool({ name: 'estimate_cost', arguments: { source: 'google_maps', total_records: 200 } });
  assert.match(q.content[0].text, /would cost 2\.40 USD/);
});

test('API errors are returned readably', async () => {
  const r = await client.callTool({ name: 'job_status', arguments: { job_id: 999 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No job with that id/);
});

test('linkedin_leads maps filters to API field names', async () => {
  await client.callTool({
    name: 'linkedin_leads',
    arguments: { total_records: 500, job_titles: 'CMO', locations: ['california, us'], include_unverified: true },
  });
  const sent = seen.filter((s) => s.url === '/api/v1/jobs' && s.method === 'POST').pop();
  assert.equal(sent.body.source, 'linkedin');
  assert.equal(sent.body.contact_job_title, 'CMO');
  assert.deepEqual(sent.body.contact_location, ['california, us']);
  assert.equal(sent.body.include_unverified, true);
});

test('annotations: spending tools are not read-only, readers are', async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations || {}]));
  for (const n of ['google_maps_leads', 'apollo_export', 'linkedin_leads']) assert.equal(by[n].readOnlyHint, false, n);
  for (const n of ['job_status', 'download', 'check_balance', 'estimate_cost']) assert.equal(by[n].readOnlyHint, true, n);
});

test('invalid input is rejected before any API request', async () => {
  const before = seen.length;
  const bad = [
    { name: 'google_maps_leads', arguments: { search_terms: 'dentist', location: 'Austin', total_records: 150 } },
    { name: 'google_maps_leads', arguments: { search_terms: '', location: 'Austin', total_records: 100 } },
    { name: 'google_maps_leads', arguments: { search_terms: 'x'.repeat(501), location: 'Austin', total_records: 100 } },
    { name: 'apollo_export', arguments: { apollo_url: 'https://evil.example/#/people', total_records: 100 } },
    { name: 'apollo_export', arguments: { apollo_url: 'https://app.apollo.io/#/people?x=1', total_records: 100, list_name: '../../etc/passwd' } },
    { name: 'linkedin_leads', arguments: { total_records: 100, locations: Array(51).fill('germany') } },
    { name: 'job_status', arguments: { job_id: -1 } },
    { name: 'download', arguments: { job_id: 1421, limit: 20000 } },
    { name: 'estimate_cost', arguments: { source: 'google_maps', total_records: 60000 } },
  ];
  for (const call of bad) {
    const r = await client.callTool(call);
    assert.equal(r.isError, true, JSON.stringify(call));
  }
  assert.equal(seen.length, before, 'no API request for invalid input');
});

test('Maps list name never ends up empty for non-Latin searches', async () => {
  await client.callTool({ name: 'google_maps_leads', arguments: { search_terms: 'دكتور', location: 'الرياض', total_records: 100 } });
  const sent = seen.filter((s) => s.url === '/api/v1/jobs' && s.method === 'POST').pop();
  assert.equal(sent.body.list_name, 'maps-leads');
});
