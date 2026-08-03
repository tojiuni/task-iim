export type GqResult = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  replayed?: boolean;
};

export interface GoquestClient {
  request(method: string, path: string, body?: unknown): Promise<GqResult>;
}

// Cap for non-JSON error bodies (HTML error pages, raw stack traces, proxy
// errors) passed through verbatim — an unbounded upstream body would
// otherwise blow up the tool result for no informational gain.
const MAX_ERROR_BODY_CHARS = 500;

function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)} …[truncated]` : text;
}

// mapError turns a goquest non-2xx status into an agent-actionable hint,
// preserving the upstream message.
export function mapError(status: number, bodyText: string): string {
  let msg = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = (j && typeof j === "object" && "error" in j ? String((j as any).error) : bodyText) || bodyText;
  } catch {
    msg = truncate(bodyText);
  }
  switch (status) {
    case 400:
      return `Bad request: ${msg}. Check title_name format ^[a-z][a-z0-9]*(-[a-z0-9]+)+$ and required fields.`;
    case 404:
      return `Not found: ${msg}.`;
    case 409:
      return `Conflict: ${msg}.`;
    case 422:
      return `Unprocessable (likely an invalid status transition): ${msg}. Valid: pending→assigned→in_progress→completed.`;
    default:
      return status >= 500 ? `goquest server error (${status}): ${msg}` : `HTTP ${status}: ${msg}`;
  }
}

export function createClient(opts: { baseUrl: string; apiKey: string; authorizationHeader?: string; fetchImpl?: typeof fetch }): GoquestClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      let res: Response;
      try {
        // goquest-iim-jwt-only-auth: goquest's auth middleware chain runs
        // X-API-Key before JWT and short-circuits JWT parsing entirely once
        // APIKeyMiddleware has already set a requester_id (internal/auth/jwt.go
        // Middleware: `if RequesterID(r) != "" { skip }`) — so sending both
        // headers on every request, as this client used to, made the
        // per-account Authorization JWT silently inert, always falling back
        // to X-API-Key's fixed service identity. goquest-ui never sends
        // X-API-Key at all (Authorization-only, see its axios interceptor) —
        // match that: prefer the session JWT and only fall back to the static
        // API key when no Authorization header is present (stdio mode /
        // legacy single-account sessions with no per-session JWT).
        const authed = Boolean(opts.authorizationHeader);
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            ...(!authed && opts.apiKey ? { "X-API-Key": opts.apiKey } : {}),
            ...(opts.authorizationHeader ? { "Authorization": opts.authorizationHeader } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        return { ok: false, status: 0, error: `network error contacting ${base}: ${String(err)}` };
      }
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: mapError(res.status, text) };
      }
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* leave as text */
      }
      const replayed = res.headers.get("X-Idempotent-Replay") === "true";
      return { ok: true, status: res.status, data, ...(replayed ? { replayed: true } : {}) };
    },
  };
}
