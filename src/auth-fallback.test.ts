import { test } from "node:test";
import assert from "node:assert/strict";
import { currentTool, logAuthFallback, fallbackActor } from "./auth-fallback.ts";
import { apiKeyFallbackAllowed } from "./auth-policy.ts";
import { createClient } from "./client.ts";

test("step 1: one safe JSON log per fallback with tool context", async () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((line: string) => { lines.push(line); return true; }) as typeof original;
  try {
    logAuthFallback("no_authorization", "/api/v1/tickets", "list_tickets");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry).sort(), ["actor_unverified", "event", "path", "reason", "tool", "ts"]);
    assert.equal(entry.actor_unverified, "unknown");
    assert.equal(entry.event, "auth_fallback");
    assert.equal(entry.reason, "no_authorization");
    assert.equal(new Date(entry.ts).toISOString(), entry.ts);
    lines.length = 0;
    let calls = 0;
    const client = createClient({
      baseUrl: "http://gq", apiKey: "SECRET_KEY", authorizationHeader: "Bearer SECRET_TOKEN",
      allowApiKeyFallback: true,
      fetchImpl: (async () => new Response("{}", { status: ++calls === 1 ? 401 : 200 })) as typeof fetch,
    });
    await currentTool.run("get_ticket", () => client.request("GET", "/api/v1/tickets/t1?Authorization=SECRET_TOKEN&api_key=SECRET_KEY"));
    assert.equal(calls, 2);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).reason, "jwt_401");
    assert.equal(JSON.parse(lines[0]).tool, "get_ticket");
    assert.equal(JSON.parse(lines[0]).path, "/api/v1/tickets/t1");
    assert.doesNotMatch(lines[0], /SECRET|Authorization|Bearer|api_key|X-API-Key/);
    lines.length = 0;
    logAuthFallback("no_authorization", "/mcp?Authorization=SECRET_TOKEN&api_key=SECRET_KEY", undefined, true);
    assert.equal(JSON.parse(lines[0]).path, "/mcp");
    assert.doesNotMatch(lines[0], /SECRET|Authorization|Bearer|api_key|X-API-Key/);
  } finally { process.stderr.write = original; }
});

test("HTTP env parsing accepts trimmed 1 and case-insensitive true only", () => {
  for (const value of ["", "0", "false", "yes", "on", "01", "trueish"]) assert.equal(apiKeyFallbackAllowed(value), false);
  for (const value of ["1", " 1 ", "true", "TRUE", " True\n"]) assert.equal(apiKeyFallbackAllowed(value), true);
});

for (const authorizationHeader of [undefined, "Bearer expired"]) {
  test("step 2 blocks fallback: " + String(authorizationHeader), async () => {
    let calls = 0;
    let unauthorized = 0;
    const lines: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((line: string) => { lines.push(line); return true; }) as typeof original;
    try {
      const c = createClient({
        baseUrl: "http://gq", apiKey: "SECRET", authorizationHeader, allowApiKeyFallback: false,
        onUnauthorized: () => { unauthorized++; },
        fetchImpl: (async () => { calls++; return new Response("{}", { status: 401 }); }) as typeof fetch,
      });
      assert.equal((await c.request("GET", "/api/v1/tickets")).status, 401);
      assert.equal(calls, authorizationHeader ? 1 : 0);
      assert.equal(unauthorized, 1);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).event, "auth_fallback_blocked");
      assert.equal(JSON.parse(lines[0]).reason, authorizationHeader ? "jwt_401" : "no_authorization");
    } finally { process.stderr.write = original; }
  });
}

test("unset env blocks by default; env 1 restores fallback", async () => {
  const original = process.env["ALLOW_APIKEY_FALLBACK"];
  try {
    for (const value of [undefined, "true", "1"]) {
      if (value === undefined) delete process.env["ALLOW_APIKEY_FALLBACK"];
      else process.env["ALLOW_APIKEY_FALLBACK"] = value;
      let calls = 0;
      const client = createClient({
        baseUrl: "http://gq", apiKey: "SECRET",
        fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch,
      });
      assert.equal((await client.request("GET", "/api/v1/tickets")).status, value === undefined ? 401 : 200);
      assert.equal(calls, value === undefined ? 0 : 1);
    }
  } finally {
    if (original === undefined) delete process.env["ALLOW_APIKEY_FALLBACK"];
    else process.env["ALLOW_APIKEY_FALLBACK"] = original;
  }
});

test("allowed JWT 401 with empty API key passes through without HTTP hijack", async () => {
  let calls = 0;
  let unauthorized = 0;
  const client = createClient({
    baseUrl: "http://gq", apiKey: "", authorizationHeader: "Bearer expired",
    allowApiKeyFallback: true, onUnauthorized: () => { unauthorized++; },
    fetchImpl: (async () => {
      calls++;
      return new Response('{"error":"original upstream failure"}', { status: 401 });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.request("GET", "/api/v1/tickets"), {
    ok: false, status: 401, error: "HTTP 401: original upstream failure",
  });
  assert.equal(calls, 1);
  assert.equal(unauthorized, 0);
});

function observationJwt(payload: unknown): string {
  return "Bearer e30." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".signature";
}

test("observation actor uses only sanitized bounded JWT sub", () => {
  assert.equal(fallbackActor(observationJwt({ sub: "person-123", role: "SECRET_ROLE" })), "person-123");
  assert.equal(fallbackActor(observationJwt({ sub: "a\n\r\t\u0000\u007f\u0085b" })), "ab");
  assert.equal(fallbackActor(observationJwt({ sub: "x".repeat(256) })), "x".repeat(128));
  for (const header of [
    undefined, "", "Basic secret", "Bearer malformed", "Bearer a.%%%.b",
    "Bearer a.eA.b", "Bearer a._w.b", observationJwt({ sub: 42 }),
    observationJwt({ role: "admin" }), observationJwt({ sub: "" }),
  ]) assert.equal(fallbackActor(header), "unknown");
});

test("fallback and blocked logs contain actor but no token or other claims", async () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((line: string) => { lines.push(line); return true; }) as typeof original;
  const authorizationHeader = observationJwt({ sub: "actor-123", email: "PRIVATE_EMAIL", role: "PRIVATE_ROLE" });
  try {
    for (const allowApiKeyFallback of [true, false]) {
      let calls = 0;
      const client = createClient({
        baseUrl: "http://gq", apiKey: "PRIVATE_API_KEY", authorizationHeader, allowApiKeyFallback,
        fetchImpl: (async () => new Response("{}", { status: ++calls === 1 ? 401 : 200 })) as typeof fetch,
      });
      await client.request("GET", "/api/v1/tickets");
    }
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => JSON.parse(line).event), ["auth_fallback", "auth_fallback_blocked"]);
    for (const line of lines) {
      assert.equal(JSON.parse(line).actor_unverified, "actor-123");
      assert.ok(!line.includes(authorizationHeader));
      assert.ok(!line.includes(authorizationHeader.slice(7)));
      assert.doesNotMatch(line, /PRIVATE_|Authorization|Bearer|signature|email|role/);
    }
    lines.length = 0;
    logAuthFallback("no_authorization", "/mcp", undefined, true);
    logAuthFallback("jwt_401", "/api/v1/tickets", undefined, false, "Bearer malformed");
    logAuthFallback("jwt_401", "/api/v1/tickets", undefined, true, observationJwt({ sub: "z".repeat(256) }));
    assert.deepEqual(lines.map(line => JSON.parse(line).actor_unverified), ["unknown", "unknown", "z".repeat(128)]);
  } finally { process.stderr.write = original; }
});
