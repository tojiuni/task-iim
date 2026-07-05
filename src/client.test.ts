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
