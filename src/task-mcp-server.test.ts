import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { createHttpHandler } from "./task-mcp-server.ts";

// Exercise the real HTTP adapter and SDK without binding a listening socket.
for (const allowApiKeyFallback of [false, true]) {
  for (const authorization of [undefined, "Bearer expired"]) {
    test("HTTP auth: " + JSON.stringify({ allowApiKeyFallback, authorization }), async () => {
      const headersSeen: Headers[] = [];
      const handler = createHttpHandler({
        baseUrl: "http://gq", apiKey: "SERVICE", allowApiKeyFallback,
        fetchImpl: (async (_url, init) => {
          const headers = new Headers(init?.headers);
          headersSeen.push(headers);
          return new Response(headers.has("Authorization") ? '{"error":"expired"}' : '{"id":"t1"}',
            { status: headers.has("Authorization") ? 401 : 200 });
        }) as typeof fetch,
      });
      const req = new IncomingMessage(new Socket());
      req.method = "POST";
      req.url = "/mcp";
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_ticket", arguments: { id: "t1" } } });
      req.headers = {
        host: "localhost", "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
        "content-length": String(Buffer.byteLength(body)),
        ...(authorization ? { authorization } : {}),
      };
      req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => [k, String(v)]);
      req.push(body);
      req.push(null);
      const res = new ServerResponse(req);
      let output = "";
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
      });
      res.assignSocket(socket as Socket);
      const finished = once(res, "finish");
      await handler(req, res);
      await finished;
      assert.equal(res.statusCode, allowApiKeyFallback ? 200 : 401, output);
      if (!allowApiKeyFallback) {
        assert.match(output, authorization
          ? /www-authenticate: Bearer error="invalid_token"\r\n/i
          : /www-authenticate: Bearer\r\n/i);
        assert.match(output, /Authentication required/);
        assert.doesNotMatch(output, /"result"/);
      }
      assert.equal(headersSeen.length, allowApiKeyFallback ? (authorization ? 2 : 1) : (authorization ? 1 : 0));
      if (allowApiKeyFallback) assert.equal(headersSeen.at(-1)?.get("X-API-Key"), "SERVICE");
      res.emit("close");
      socket.destroy();
      req.destroy();
    });
  }
}

test("stdio retains static API-key auth with HTTP fallback disabled or unset", async () => {
  const { createStdioClient } = await import("./task-mcp-server.ts");
  const originalEnv = process.env["ALLOW_APIKEY_FALLBACK"];
  const originalWrite = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((line: string) => { lines.push(line); return true; }) as typeof originalWrite;
  try {
    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env["ALLOW_APIKEY_FALLBACK"];
      else process.env["ALLOW_APIKEY_FALLBACK"] = value;
      let calls = 0;
      const client = createStdioClient({
        baseUrl: "http://gq", apiKey: "STDIO_SECRET",
        fetchImpl: (async (_url, init) => {
          calls++;
          assert.equal(new Headers(init?.headers).get("X-API-Key"), "STDIO_SECRET");
          return new Response('{"id":"t1"}');
        }) as typeof fetch,
      });
      assert.equal((await client.request("GET", "/api/v1/tickets/t1")).ok, true);
      assert.equal(calls, 1);
    }
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => JSON.parse(line).event === "auth_fallback"));
    assert.doesNotMatch(lines.join(""), /STDIO_SECRET|auth_fallback_blocked/);
  } finally {
    process.stderr.write = originalWrite;
    if (originalEnv === undefined) delete process.env["ALLOW_APIKEY_FALLBACK"];
    else process.env["ALLOW_APIKEY_FALLBACK"] = originalEnv;
  }
});
