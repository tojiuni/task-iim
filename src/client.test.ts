import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, mapError } from "./client.ts";

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async (_url: string | URL, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

test("request sends X-API-Key and returns parsed data on 200", async () => {
  let seenAuth = "";
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    seenAuth = new Headers(init?.headers).get("X-API-Key") ?? "";
    return new Response(JSON.stringify({ id: "t1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "KEY", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/t1");
  assert.equal(seenAuth, "KEY");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { id: "t1" });
});

test("replayed flag set from X-Idempotent-Replay header", async () => {
  const c = createClient({ baseUrl: "http://gq", apiKey: "K", fetchImpl: fakeFetch(200, { id: "x" }, { "X-Idempotent-Replay": "true" }) });
  const r = await c.request("POST", "/api/v1/tickets", { title: "t" });
  assert.equal(r.replayed, true);
});

test("non-2xx yields ok=false with mapped error hint", async () => {
  const c = createClient({ baseUrl: "http://gq", apiKey: "K", fetchImpl: fakeFetch(400, { error: "title_name must be lowercase" }) });
  const r = await c.request("POST", "/api/v1/tickets", {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error!, /title_name/);
});

test("mapError gives transition hint on 422", () => {
  assert.match(mapError(422, "bad transition"), /transition/i);
});

test("mapError caps unbounded non-JSON error bodies (e.g. HTML error pages) at ~500 chars", () => {
  const huge = "<html>" + "x".repeat(5000) + "</html>";
  const msg = mapError(502, huge);
  assert.ok(msg.length < 600, `expected capped message, got length ${msg.length}`);
  assert.match(msg, /\[truncated\]/);
});

test("mapError leaves short non-JSON bodies untouched (no spurious truncation marker)", () => {
  const msg = mapError(502, "upstream connection refused");
  assert.match(msg, /upstream connection refused/);
  assert.doesNotMatch(msg, /\[truncated\]/);
});

test("authorizationHeader is forwarded as Authorization header", async () => {
  let seenAuth = "";
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify({ id: "t2" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "", authorizationHeader: "Bearer jwt.token.here", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/t2");
  assert.equal(seenAuth, "Bearer jwt.token.here");
  assert.equal(r.ok, true);
});

test("no Authorization header sent when authorizationHeader is absent", async () => {
  let seenAuth: string | null = "SENTINEL";
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    seenAuth = new Headers(init?.headers).get("Authorization");
    return new Response(JSON.stringify({ id: "t3" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "KEY", fetchImpl });
  await c.request("GET", "/api/v1/tickets/t3");
  assert.equal(seenAuth, null);
});

// goq-mcp-jwt-only-auth: goquest's auth middleware short-circuits JWT parsing
// once X-API-Key has already set a requester_id, so sending both headers made
// the per-account Authorization JWT silently inert. When a session JWT is
// present, X-API-Key must be omitted entirely (goquest-ui never sends it).
test("X-API-Key is omitted when authorizationHeader is present, even if apiKey is set", async () => {
  let seenApiKey: string | null = "SENTINEL";
  let seenAuth = "";
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seenApiKey = h.get("X-API-Key");
    seenAuth = h.get("Authorization") ?? "";
    return new Response(JSON.stringify({ id: "t4" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "SERVICE-KEY", authorizationHeader: "Bearer jwt.token.here", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/t4");
  assert.equal(seenApiKey, null, "X-API-Key must not be sent when a session JWT is present");
  assert.equal(seenAuth, "Bearer jwt.token.here");
  assert.equal(r.ok, true);
});

test("X-API-Key is still sent as fallback when no authorizationHeader is present", async () => {
  let seenApiKey: string | null = "SENTINEL";
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    seenApiKey = new Headers(init?.headers).get("X-API-Key");
    return new Response(JSON.stringify({ id: "t5" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "SERVICE-KEY", fetchImpl });
  await c.request("GET", "/api/v1/tickets/t5");
  assert.equal(seenApiKey, "SERVICE-KEY");
});

// goq-mcp-jwt-expiry-fallback: the MCP client caches .mcp.json's Authorization
// header for the session's lifetime and doesn't pick up tokenhub-refresher's
// periodic re-writes without a manual /mcp reconnect, so a stale JWT would
// otherwise hard-fail every call with 401 until the user notices. Retry once
// with X-API-Key so the tool call still succeeds.
test("a 401 on the JWT attempt is retried once with X-API-Key, and succeeds", async () => {
  const seenAuthByCall: (string | null)[] = [];
  const seenApiKeyByCall: (string | null)[] = [];
  let calls = 0;
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    calls += 1;
    const h = new Headers(init?.headers);
    seenAuthByCall.push(h.get("Authorization"));
    seenApiKeyByCall.push(h.get("X-API-Key"));
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "invalid token: token has invalid claims: token is expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "t6" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "SERVICE-KEY", authorizationHeader: "Bearer expired.jwt.here", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/t6");
  assert.equal(calls, 2, "expected exactly one retry");
  assert.equal(seenAuthByCall[0], "Bearer expired.jwt.here");
  assert.equal(seenApiKeyByCall[0], null, "first attempt must still be JWT-only");
  assert.equal(seenAuthByCall[1], null, "retry must not also send the stale Authorization header");
  assert.equal(seenApiKeyByCall[1], "SERVICE-KEY");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { id: "t6" });
});

test("a 401 with no apiKey configured is not retried and propagates as-is", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "", authorizationHeader: "Bearer expired.jwt.here", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/t7");
  assert.equal(calls, 1, "no apiKey to fall back to, so no retry");
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("a non-401 error on the JWT attempt is not retried with X-API-Key", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const c = createClient({ baseUrl: "http://gq", apiKey: "SERVICE-KEY", authorizationHeader: "Bearer valid.jwt.here", fetchImpl });
  const r = await c.request("GET", "/api/v1/tickets/missing");
  assert.equal(calls, 1, "404 must not trigger the 401-only fallback");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});
