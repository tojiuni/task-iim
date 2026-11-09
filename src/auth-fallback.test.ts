import { test } from "node:test";
import assert from "node:assert/strict";
import { currentTool, logAuthFallback } from "./auth-fallback.ts";
import { apiKeyFallbackAllowed } from "./auth-policy.ts";
import { createClient } from "./client.ts";

test("step 1: one safe JSON log per fallback with tool context", async () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((line: string) => { lines.push(line); return true; }) as typeof original;
  try {
    logAuthFallback("no_authorization", "/api/v1/tickets", "list_tickets");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry).sort(), ["event", "path", "reason", "tool", "ts"]);
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
    await currentTool.run("get_ticket", () => client.request("GET", "/api/v1/tickets/t1"));
    assert.equal(calls, 2);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).reason, "jwt_401");
    assert.equal(JSON.parse(lines[0]).tool, "get_ticket");
    assert.doesNotMatch(lines[0], /SECRET/);
  } finally { process.stderr.write = original; }
});

test("step 2 accepts only exact env value 1", () => {
  for (const value of ["", "0", "true", "yes", " 1"]) assert.equal(apiKeyFallbackAllowed(value), false);
  assert.equal(apiKeyFallbackAllowed("1"), true);
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
      assert.equal((await client.request("GET", "/api/v1/tickets")).status, value === "1" ? 200 : 401);
      assert.equal(calls, value === "1" ? 1 : 0);
    }
  } finally {
    if (original === undefined) delete process.env["ALLOW_APIKEY_FALLBACK"];
    else process.env["ALLOW_APIKEY_FALLBACK"] = original;
  }
});
