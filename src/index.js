#!/usr/bin/env node
/**
 * Evascrape MCP server (stdio).
 *
 * Tool descriptions are written for the model: they include example requests
 * phrased the way users actually ask ("find 200 dentists in Austin with their
 * emails") so the right tool is picked.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EvascrapeClient, EvascrapeError, CLIENT_VERSION } from './client.js';

const VERSION = CLIENT_VERSION;
let client;
try {
  client = new EvascrapeClient({ apiKey: process.env.EVASCRAPE_API_KEY });
} catch (err) {
  // stdout is reserved for the protocol; configuration errors go to stderr. The key is never written.
  process.stderr.write(`evascrape-mcp: ${err.message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------ Input schemas -----
 * Every tool input is bounded here. The authoritative validation happens on
 * the server (app.evascrape.com); these limits reject malformed or oversized
 * input before any request is sent.
 */
const text = (max) => z.string().trim().min(1).max(max);
const records = z.number().int().min(100).max(50000).multipleOf(100);
const listName = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9 _-]+$/, 'Letters, numbers, spaces, hyphens and underscores only.');
const shortList = z.array(z.string().trim().min(1).max(120)).max(50);
const jobId = z.number().int().positive();

/** Tools that spend prepaid credit: not read-only, not idempotent. */
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Read-only tools. */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Success: readable text plus a machine-readable body. */
function ok(text, structured) {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

/** Error: message the agent can act on. */
function fail(err) {
  const message = err instanceof EvascrapeError
    ? `${err.message}${err.code === 'insufficient_credits' ? ' Top up at https://app.evascrape.com/account/payment' : ''}`
    : `Unexpected error: ${err.message}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Summary telling the agent what to do after starting a job. */
function startedText(job, cost) {
  return [
    `Started job ${job.id} (${job.source}).`,
    `Requested up to ${job.requested_records} records. Reserved ${cost ?? job.credits_charged} USD from the balance.`,
    '',
    `Next: call job_status with job_id ${job.id} in about 30 seconds. When status is "succeeded", call download with the same id.`,
    'You are refunded automatically for anything that could not be delivered.',
  ].join('\n');
}

function jobText(job) {
  const lines = [`Job ${job.id} (${job.source}) is ${job.status}.`];
  if (job.delivered_records != null) {
    lines.push(`Delivered ${job.delivered_records} of ${job.requested_records} requested.`);
    if (job.records_with_email != null) lines.push(`${job.records_with_email} of them have an email address.`);
  }
  lines.push(`Charged ${job.credits_charged} USD, refunded ${job.credits_refunded} USD.`);
  if (job.error) lines.push(`Note: ${job.error}`);
  if (job.status === 'succeeded') lines.push(`Results are ready. Call download with job_id ${job.id}.`);
  else if (job.status === 'queued' || job.status === 'running') lines.push('Check again in about 30 seconds.');
  else if (job.status === 'no_results') lines.push('Nothing matched those filters, and the full amount was refunded. Try a broader search.');
  return lines.join('\n');
}

const server = new McpServer({ name: 'evascrape', version: VERSION });

/* ---------------------------------------------------------------- Maps ---- */

server.registerTool('google_maps_leads', {
  title: 'Find business leads on Google Maps',
  description: [
    'Find local businesses and their contact details from Google Maps: name, address, phone, website,',
    'rating, and the email address published on the business website where there is one.',
    'Use this for requests like "find 200 dentists in Austin with their emails",',
    '"get me restaurants in Berlin with phone numbers" or "build a list of plumbers near Manchester".',
    'This is the best starting point for local business prospecting. Costs $12 per 1,000 records from a',
    'prepaid balance; you are refunded for anything not delivered. Returns a job id, not the data:',
    'poll job_status, then call download.',
  ].join(' '),
  inputSchema: {
    search_terms: text(500).describe('What kind of business, comma separated. Example: "dentist" or "dentist, orthodontist".'),
    location: text(200).describe('Where to search. A city, region or country. Example: "Austin, Texas".'),
    total_records: records.describe('Maximum records to collect. Multiple of 100, minimum 100, maximum 50000. This is a ceiling, not a promise.'),
    email_verification: z.boolean().optional().describe('Verify every email in real time for an extra $5 per 1,000. Default false.'),
    min_rating: z.enum(['', '3', '3.5', '4', '4.5']).optional().describe('Only include places at or above this Google rating.'),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional().describe('Google Maps interface language, e.g. "en", "de", "tr". Default "en".'),
    categories: text(500).optional().describe('Optional extra category filter, comma separated.'),
    skip_closed: z.boolean().optional().describe('Skip permanently closed places. Default false.'),
    list_name: listName.optional().describe('Name for the export file. Defaults to a name built from the search.'),
  },
  annotations: SPENDS,
}, async (args) => {
  try {
    const body = {
      source: 'google_maps',
      list_name: args.list_name || `${args.search_terms}-${args.location}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'maps-leads',
      total_records: args.total_records,
      search_terms: args.search_terms,
      location: args.location,
      email_verification: Boolean(args.email_verification),
      ...(args.min_rating != null ? { min_rating: args.min_rating } : {}),
      ...(args.language ? { language: args.language } : {}),
      ...(args.categories ? { categories: args.categories } : {}),
      ...(args.skip_closed != null ? { skip_closed: args.skip_closed } : {}),
    };
    const { job } = await client.createJob(body);
    return ok(startedText(job), { job });
  } catch (err) { return fail(err); }
});

/* -------------------------------------------------------------- Apollo ---- */

server.registerTool('apollo_export', {
  title: 'Export an Apollo.io search',
  description: [
    'Export the results of a people search you already built on Apollo.io, past Apollo\'s own export cap',
    'and without consuming Apollo export credits. You must supply the Apollo search URL.',
    'Only leads that have a verified email address are delivered, so the count can be lower than the',
    'number Apollo displays. Costs $9 per 1,000. Returns a job id: poll job_status, then download.',
  ].join(' '),
  inputSchema: {
    apollo_url: z.string().trim().max(8000).url().refine((u) => /^https:\/\/([a-z0-9-]+\.)*apollo\.io\//i.test(u), 'Must be an https://app.apollo.io/ URL.').describe('A people search URL copied from Apollo.io, e.g. https://app.apollo.io/#/people?personTitles[]=cto. The URL must carry at least one filter (job title, location, company keywords or employee size); a bare URL is rejected because it would return everything. Filters Evascrape cannot read, such as a saved Apollo persona, are ignored, so the list can come back broader than the Apollo screen showed.'),
    total_records: records.describe('Maximum leads to export. Multiple of 100, minimum 100, maximum 50000.'),
    email_verification: z.boolean().optional().describe('Extra real-time verification for $5 per 1,000. Default false.'),
    list_name: listName.optional().describe('Name for the export file.'),
  },
  annotations: SPENDS,
}, async (args) => {
  try {
    const { job } = await client.createJob({
      source: 'apollo',
      list_name: args.list_name || 'apollo-export',
      total_records: args.total_records,
      apollo_url: args.apollo_url,
      email_verification: Boolean(args.email_verification),
    });
    return ok(startedText(job), { job });
  } catch (err) { return fail(err); }
});

/* ------------------------------------------------------------ LinkedIn ---- */

server.registerTool('linkedin_leads', {
  title: 'Find people on LinkedIn by filters',
  description: [
    'Build a list of people from LinkedIn and Sales Navigator audiences using filters, and get their',
    'verified work email addresses. This takes filters, not a LinkedIn URL: job titles, locations,',
    'company domains, keywords, industry, company size and revenue range.',
    'Use it for requests like "CMOs at SaaS companies in California" or "heads of engineering at',
    'companies using Stripe". Costs $9 per 1,000. If you get far fewer results than requested, set',
    'include_unverified to true: that single filter is the most common reason a list comes back short.',
    'Returns a job id: poll job_status, then download.',
  ].join(' '),
  inputSchema: {
    total_records: records.describe('Maximum leads. Multiple of 100, minimum 100, maximum 50000.'),
    job_titles: text(1000).optional().describe('Comma separated job titles to include. Example: "CMO, VP Marketing".'),
    exclude_job_titles: text(1000).optional().describe('Comma separated job titles to exclude.'),
    locations: shortList.optional().describe('Regions or countries from Evascrape\'s list, lowercase. US states end in ", us" (e.g. "california, us"), other regions in ", <country>" (e.g. "england, united kingdom"), or a bare country name ("germany"). Unknown values are rejected.'),
    exclude_locations: shortList.optional().describe('Regions or countries to exclude.'),
    seniority: shortList.optional().describe('Seniority levels, e.g. ["c_suite","director","founder"].'),
    company_domains: text(2000).optional().describe('Comma separated company domains. Domains, not names: "stripe.com", not "Stripe".'),
    keywords: text(1000).optional().describe('Company keywords to include.'),
    exclude_keywords: text(1000).optional().describe('Company keywords to exclude.'),
    industries: shortList.optional().describe('Industries to include, lowercase.'),
    company_sizes: shortList.optional().describe('Headcount bands, e.g. ["51-100","101-200"].'),
    min_revenue: z.string().trim().max(20).optional().describe('Minimum company revenue band, e.g. "1M".'),
    max_revenue: z.string().trim().max(20).optional().describe('Maximum company revenue band, e.g. "50M".'),
    funding: shortList.optional().describe('Funding stages, e.g. ["seed","series_a"].'),
    include_unverified: z.boolean().optional().describe('Include people whose email is not yet verified. Greatly increases volume. Default false.'),
    email_verification: z.boolean().optional().describe('Extra real-time verification for $5 per 1,000. Default false.'),
    list_name: listName.optional().describe('Name for the export file.'),
  },
  annotations: SPENDS,
}, async (args) => {
  try {
    const { job } = await client.createJob({
      source: 'linkedin',
      list_name: args.list_name || 'linkedin-leads',
      total_records: args.total_records,
      contact_job_title: args.job_titles,
      contact_not_job_title: args.exclude_job_titles,
      contact_location: args.locations,
      contact_not_location: args.exclude_locations,
      seniority_level: args.seniority,
      company_domain: args.company_domains,
      company_keywords: args.keywords,
      company_not_keywords: args.exclude_keywords,
      company_industry: args.industries,
      size: args.company_sizes,
      min_revenue: args.min_revenue,
      max_revenue: args.max_revenue,
      funding: args.funding,
      include_unverified: Boolean(args.include_unverified),
      email_verification: Boolean(args.email_verification),
    });
    return ok(startedText(job), { job });
  } catch (err) { return fail(err); }
});

/* -------------------------------------------------------------- Status ---- */

server.registerTool('job_status', {
  title: 'Check an extraction job',
  description: [
    'Check whether an Evascrape job has finished. Call this about 30 seconds after starting a job and',
    'then every 20 to 30 seconds. When the status is "succeeded", call download to read the records.',
  ].join(' '),
  inputSchema: { job_id: jobId.describe('The id returned when the job was started.') },
  annotations: READS,
}, async ({ job_id }) => {
  try {
    const { job } = await client.job(job_id);
    return ok(jobText(job), { job });
  } catch (err) { return fail(err); }
});

/* ------------------------------------------------------------- Download --- */

server.registerTool('download', {
  title: 'Download the records of a finished job',
  description: [
    'Read the records of a finished Evascrape job as structured data. Returns the field names and the',
    'rows, paged. Ask for a job that has already reached the status "succeeded".',
    'With email verification enabled you can pick a variant: "good" for deliverable addresses only,',
    '"risk" for catch-all, "bad" for undeliverable. Default "all".',
  ].join(' '),
  inputSchema: {
    job_id: jobId.describe('The finished job id.'),
    limit: z.number().int().min(1).max(10000).optional().describe('How many records to return. Default 1000, maximum 10000.'),
    offset: z.number().int().min(0).max(1000000).optional().describe('Skip this many records, for paging. Default 0.'),
    variant: z.enum(['all', 'good', 'risk', 'bad']).optional().describe('Which file to read. Default "all".'),
  },
  annotations: READS,
}, async ({ job_id, limit, offset, variant }) => {
  try {
    const data = await client.results(job_id, { limit, offset, variant });
    const header = `Job ${data.job_id}: ${data.records.length} of ${data.total} records`
      + `${data.has_more ? ` (more available, use offset ${data.offset + data.records.length})` : ''}.`;
    const preview = data.records.slice(0, 3).map((r) => JSON.stringify(r)).join('\n');
    return ok(`${header}\nFields: ${data.fields.join(', ')}\n\nFirst rows:\n${preview}`, data);
  } catch (err) { return fail(err); }
});

/* ----------------------------------------------------- Balance and price - */

server.registerTool('check_balance', {
  title: 'Check the Evascrape credit balance',
  description: 'Show how much prepaid credit is left on the Evascrape account, in USD. Check this before starting a large job.',
  inputSchema: {},
  annotations: READS,
}, async () => {
  try {
    const b = await client.balance();
    return ok(`Evascrape balance: ${b.credits} ${b.currency}.`, b);
  } catch (err) { return fail(err); }
});

server.registerTool('estimate_cost', {
  title: 'Estimate the cost of a job before starting it',
  description: [
    'Return what a job would cost without starting it or charging anything.',
    'Use this before spending on behalf of someone, or when the user asks how much a list will cost.',
  ].join(' '),
  inputSchema: {
    source: z.enum(['google_maps', 'apollo', 'linkedin']).describe('Which source the job would use.'),
    total_records: records.describe('How many records the job would request. Multiple of 100, 100 to 50000.'),
    email_verification: z.boolean().optional().describe('Whether real-time email verification would be enabled.'),
  },
  annotations: READS,
}, async (args) => {
  try {
    const q = await client.quote({
      source: args.source,
      total_records: args.total_records,
      email_verification: Boolean(args.email_verification),
    });
    return ok(
      `${args.total_records} ${args.source} records would cost ${q.cost.total} ${q.currency}`
      + `${Number(q.cost.verification) > 0 ? ` (${q.cost.base} base + ${q.cost.verification} verification)` : ''}.`
      + ` ${q.note}`,
      q,
    );
  } catch (err) { return fail(err); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
