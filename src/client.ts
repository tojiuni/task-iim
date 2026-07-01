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

// mapError turns a goquest non-2xx status into an agent-actionable hint,
// preserving the upstream message.
export function mapError(status: number, bodyText: string): string {
  let msg = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = (j && typeof j === "object" && "error" in j ? String((j as any).error) : bodyText) || bodyText;
  } catch {
    /* keep raw */
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

export function createClient(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): GoquestClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            "X-API-Key": opts.apiKey,
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
