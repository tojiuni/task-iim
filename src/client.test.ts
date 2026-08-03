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
