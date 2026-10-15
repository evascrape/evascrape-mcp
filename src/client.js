/**
 * Evascrape public API client.
 *
 * Single responsibility: HTTP. The MCP layer adds the tool definitions on top.
 * Errors are read from the API's error envelope ({ error: { code, message } });
 * the text shown to the agent is always the human-readable `message`.
 */

const DEFAULT_BASE = 'https://app.evascrape.com';
/** Sent as the User-Agent ("evascrape-mcp/<version>"). */
export const CLIENT_VERSION = '1.0.0';

export class EvascrapeError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'EvascrapeError';
    this.code = code || 'request_failed';
    this.status = status || 0;
  }
}

/**
 * The key only travels over HTTPS. Plain HTTP is allowed for a local test
 * server (localhost / 127.0.0.1 / ::1); anything else is rejected at startup.
 */
export function resolveBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(value); } catch {
    throw new EvascrapeError('EVASCRAPE_BASE_URL is not a valid URL.', 'invalid_base_url', 0);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new EvascrapeError('EVASCRAPE_BASE_URL must use https.', 'invalid_base_url', 0);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EvascrapeError('EVASCRAPE_BASE_URL must be a plain origin such as https://app.evascrape.com.', 'invalid_base_url', 0);
  }
  return value;
}

/** Never echo the key back, e.g. if a misconfigured proxy reflects the header. */
function redact(text, key) {
  const s = String(text ?? '');
  return key && key.length >= 8 ? s.split(key).join('[redacted]') : s;
}

export class EvascrapeClient {
  constructor({ apiKey, baseUrl } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
    this.baseUrl = resolveBaseUrl(baseUrl || process.env.EVASCRAPE_BASE_URL);
  }

  async request(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) {
      throw new EvascrapeError(
        'No API key. Set EVASCRAPE_API_KEY in the MCP server config. Create a key at https://app.evascrape.com/account/api-keys',
        'missing_api_key', 0,
      );
    }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': `evascrape-mcp/${CLIENT_VERSION}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new EvascrapeError(`Could not reach Evascrape: ${redact(err.message, this.apiKey)}`, 'network_error', 0);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* CSV or empty body */ }

    if (!res.ok) {
      const code = data?.error?.code || 'request_failed';
      const message = data?.error?.message || `Evascrape returned HTTP ${res.status}.`;
      throw new EvascrapeError(redact(message, this.apiKey), redact(code, this.apiKey), res.status);
    }
    return data;
  }

  me() { return this.request('/me'); }
  balance() { return this.request('/balance'); }
  quote(body) { return this.request('/quote', { method: 'POST', body }); }
  createJob(body) { return this.request('/jobs', { method: 'POST', body, timeoutMs: 60000 }); }
  job(id) { return this.request(`/jobs/${encodeURIComponent(id)}`); }
  results(id, { limit, offset, variant } = {}) {
    const q = new URLSearchParams();
    if (limit != null) q.set('limit', String(limit));
    if (offset != null) q.set('offset', String(offset));
    if (variant) q.set('variant', variant);
    const qs = q.toString();
    return this.request(`/jobs/${encodeURIComponent(id)}/results${qs ? `?${qs}` : ''}`, { timeoutMs: 60000 });
  }
}
