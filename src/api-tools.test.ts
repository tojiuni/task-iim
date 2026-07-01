import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoquestClient } from "./client.ts";
import { apiTools, condenseOpenAPI } from "./api-tools.ts";

const SPEC = {
  openapi: "3.1.0",
  paths: {
    "/tickets": { post: { summary: "Create a ticket" }, get: { summary: "List tickets" } },
    "/tickets/by-name/{title_name}": { get: { summary: "Look up by title_name" } },
  },
};

test("condenseOpenAPI yields one line per operation", () => {
  const lines = condenseOpenAPI(SPEC);
  assert.ok(lines.includes("POST /tickets — Create a ticket"));
  assert.ok(lines.includes("GET /tickets — List tickets"));
  assert.ok(lines.includes("GET /tickets/by-name/{title_name} — Look up by title_name"));
});

test("condenseOpenAPI handles put/patch/delete and omits dangling em-dash", () => {
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/tickets/{id}": {
        put: { summary: "Replace ticket" },
        patch: { operationId: "patchTicket" },
        delete: {},
      },
    },
  };
  const lines = condenseOpenAPI(spec);
  assert.ok(lines.includes("PUT /tickets/{id} — Replace ticket"));
  assert.ok(lines.includes("PATCH /tickets/{id} — patchTicket"));
  assert.ok(lines.includes("DELETE /tickets/{id}"));
  const deleteLine = lines.find((l) => l.startsWith("DELETE"))!;
  assert.equal(deleteLine, "DELETE /tickets/{id}");
  assert.ok(!deleteLine.endsWith("—"));
  assert.ok(!deleteLine.endsWith(" "));
});

test("list_api returns condensed list by default", async () => {
  const c: GoquestClient = { async request() { return { ok: true, status: 200, data: SPEC }; } };
  const t = apiTools.find((x) => x.name === "list_api")!;
  const r = await t.handler({}, c);
  assert.match(r.content[0].text, /POST \/tickets — Create a ticket/);
});

test("list_api full=true returns raw spec", async () => {
  const c: GoquestClient = { async request() { return { ok: true, status: 200, data: SPEC }; } };
  const t = apiTools.find((x) => x.name === "list_api")!;
  const r = await t.handler({ full: true }, c);
  assert.match(r.content[0].text, /"openapi": "3.1.0"/);
});
