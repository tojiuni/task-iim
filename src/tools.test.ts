import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoquestClient, GqResult } from "./client.ts";
import { readTools } from "./tools.ts";

function stubClient(handler: (m: string, p: string, b?: unknown) => GqResult): GoquestClient {
  return { async request(m, p, b) { return handler(m, p, b); } };
}
function byName(name: string) {
  const t = readTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

test("get_ticket calls GET /api/v1/tickets/{id}", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = `${m} ${p}`; return { ok: true, status: 200, data: { id: "abc" } }; });
  const r = await byName("get_ticket").handler({ id: "abc" }, c);
  assert.equal(seen, "GET /api/v1/tickets/abc");
  assert.match(r.content[0].text, /"id": "abc"/);
});

test("get_ticket_by_name builds by-name path with workspace+project query", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = p; return { ok: true, status: 200, data: {} }; });
  await byName("get_ticket_by_name").handler({ title_name: "goq-x", workspace: "toji", project: "whoami" }, c);
  assert.ok(seen.startsWith("/api/v1/tickets/by-name/goq-x?"));
  assert.match(seen, /workspace=toji/);
  assert.match(seen, /project=whoami/);
});

test("list_tickets appends repeated tag and filters", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = p; return { ok: true, status: 200, data: { tickets: [] } }; });
  await byName("list_tickets").handler({ project_id: "p1", tag: ["infra", "urgent"], status: "pending" }, c);
  assert.match(seen, /tag=infra/);
  assert.match(seen, /tag=urgent/);
  assert.match(seen, /status=pending/);
  assert.match(seen, /project_id=p1/);
});

test("error result marks isError and shows the hint", async () => {
  const c = stubClient(() => ({ ok: false, status: 404, error: "Not found: x." }));
  const r = await byName("get_ticket").handler({ id: "zzz" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});
