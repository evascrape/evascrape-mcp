# Evascrape MCP server

Find business leads with email addresses from inside Claude, Cursor or any other MCP client.

Ask your assistant things like:

- *"Find 200 dentists in Austin with their email addresses."*
- *"Get me every plumber in Manchester with a phone number and website."*
- *"Export this Apollo search and give me the emails."*
- *"Build a list of CMOs at SaaS companies in California."*

Evascrape runs the extraction on its own servers and returns structured records. Nothing runs in your
browser and no source-platform login is used.

## Get an API key

1. Create an account at [app.evascrape.com](https://app.evascrape.com/signup?ref=mcpsrv).
2. Top up prepaid credit in the app. Top-ups start from $10. There is no free credit and no subscription.
3. Create a key at [app.evascrape.com/account/api-keys](https://app.evascrape.com/account/api-keys).
   Keys start with `evs_live_`.

Keep the key in your MCP client's config or secret store. Do not commit it to a repository.

## Install

Requires Node.js 18 or newer.

### Claude Code

```bash
claude mcp add evascrape --env EVASCRAPE_API_KEY=evs_live_xxx -- npx -y @evascrape/mcp
```

### Claude Desktop, Cursor, Windsurf and other clients

Add this to the client's MCP config file (`claude_desktop_config.json`, `~/.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "evascrape": {
      "command": "npx",
      "args": ["-y", "@evascrape/mcp"],
      "env": { "EVASCRAPE_API_KEY": "evs_live_xxx" }
    }
  }
}
```

Claude Desktop users can also install the `evascrape.mcpb` file from the
[latest GitHub release](https://github.com/evascrape/evascrape-mcp/releases/latest): open it with Claude Desktop
and paste the key when asked. The key is stored as a secret field.

## Tools

| Tool | What it does | Spends credit |
| --- | --- | --- |
| `google_maps_leads` | Businesses from Google Maps: name, address, phone, website, rating, email where published | yes |
| `apollo_export` | Export a people search you already built on Apollo.io | yes |
| `linkedin_leads` | People from LinkedIn audiences by job title, location, company, revenue | yes |
| `job_status` | Check whether an extraction has finished | no |
| `download` | Read the finished records as structured data | no |
| `check_balance` | Remaining prepaid credit | no |
| `estimate_cost` | Price a job before starting it | no |

Extractions are asynchronous: a tool call starts the job and returns an id, `job_status` reports
progress, and `download` returns the records once the job has succeeded.

The three tools that start a job spend prepaid credit. Most MCP clients ask you to approve each tool
call; ask the assistant to run `estimate_cost` first if you want to see the price before a job starts.

## Pricing

Prepaid USD balance. Top-ups start from $10. No subscription, and credit does not expire.

| Source | Per 1,000 records |
| --- | --- |
| Google Maps | $12 |
| Apollo.io | $9 |
| LinkedIn / Sales Navigator | $9 |
| Real-time email verification (optional) | +$5 |

You pay for delivered records: the job reserves the amount when it starts and anything that could not be
delivered is refunded automatically. Verification is charged only for delivered records that have an
email address. Current prices: [evascrape.com/pricing](https://evascrape.com/pricing).

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `EVASCRAPE_API_KEY` | yes | Key from your Evascrape account |
| `EVASCRAPE_BASE_URL` | no | Override the API host, for testing. Must be `https`. |

## Security and privacy

- The key is sent only to `https://app.evascrape.com` (or the `https` host you set), as a Bearer header.
  It is never written to stdout, logs or error messages.
- Tool inputs are validated before any request is made.
- Requests identify themselves with the `evascrape-mcp/<version>` user agent.
- Only publicly available business data is collected; never private messages or login-protected content.
  See [data sources and removal requests](https://evascrape.com/compliance).

## Privacy Policy

This server runs on your machine and sends your tool inputs (search terms, locations, filters, Apollo
URLs, job ids) and your API key to the Evascrape API at `app.evascrape.com` to run and read jobs. It
does not collect anything else and keeps no local files, logs or telemetry. Evascrape stores the jobs
and their results in your account. How Evascrape collects, uses, shares and retains data, and how to
contact us, is described in the [Evascrape Privacy Policy](https://evascrape.com/privacy-policy).
Questions: info@evascrape.com.

## Notes

- LinkedIn jobs take filters, not a search URL. If a list comes back short, set `include_unverified` to true.
- The same API is available directly over HTTP: [evascrape.com/docs](https://evascrape.com/docs),
  OpenAPI at [evascrape.com/docs/openapi.json](https://evascrape.com/docs/openapi.json).

## Development

```bash
npm install
npm test
```

Tests run the real MCP stdio protocol against a local mock API; they never call Evascrape.

MIT licensed.
