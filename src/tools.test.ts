import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoquestClient, GqResult } from "./client.ts";
import { readTools, writeTools, vcsTools } from "./tools.ts";

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

function wByName(name: string) {
  const t = writeTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const vByName = (n: string) => vcsTools.find((t) => t.name === n)!;

test("create_ticket POSTs mapped body with name-based fields", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler(
    { title: "Do X", title_name: "goq-do-x", workspace: "toji", project: "goquest", tag_names: ["infra"], domain: "code", ref_ids: ["geneso:whoami/spec/foo.md"] },
    c,
  );
  assert.equal(body.title, "Do X");
  assert.equal(body.title_name, "goq-do-x");
  assert.equal(body.workspace_name, "toji");
  assert.equal(body.project_name, "goquest");
  assert.deepEqual(body.tag_names, ["infra"]);
  assert.equal(body.domain, "code");
  assert.deepEqual(body.ref_ids, ["geneso:whoami/spec/foo.md"]);
});

test("create_ticket auto-extracts geneso: refs mentioned in description", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler(
    {
      title: "Do X",
      title_name: "goq-do-x",
      description: "## 배경\ngeneso:goquest/spec/foo-design.md 참고. 자세한 건 (geneso:goquest/spec/bar.md) 도 확인.",
    },
    c,
  );
  assert.deepEqual(body.ref_ids, ["geneso:goquest/spec/foo-design.md", "geneso:goquest/spec/bar.md"]);
});

test("create_ticket merges explicit ref_ids with description-mentioned refs, de-duplicated", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler(
    {
      title: "Do X",
      title_name: "goq-do-x",
      ref_ids: ["geneso:goquest/spec/foo-design.md"],
      description: "geneso:goquest/spec/foo-design.md 참고, geneso:goquest/spec/extra.md 도 참고.",
    },
    c,
  );
  assert.deepEqual(body.ref_ids, ["geneso:goquest/spec/foo-design.md", "geneso:goquest/spec/extra.md"]);
});

test("create_ticket leaves ref_ids unset when neither explicit refs nor description mentions exist", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler({ title: "Do X", title_name: "goq-do-x", description: "no refs here" }, c);
  assert.equal(body.ref_ids, undefined);
});

test("create_ticket surfaces replayed flag", async () => {
  const c: GoquestClient = { async request() { return { ok: true, status: 200, data: { id: "e1" }, replayed: true }; } };
  const r = await wByName("create_ticket").handler({ title: "t", project_id: "p", title_name: "goq-t" }, c);
  assert.match(r.content[0].text, /"replayed": true/);
});

test("update_ticket PATCHes /tickets/{id} with the given fields", async () => {
  let seen = ""; let body: any;
  const c: GoquestClient = { async request(m, p, b) { seen = `${m} ${p}`; body = b; return { ok: true, status: 200, data: {} }; } };
  await wByName("update_ticket").handler({ id: "t9", status: "in_progress", ref_ids: ["geneso:whoami/spec/foo.md"] }, c);
  assert.equal(seen, "PATCH /api/v1/tickets/t9");
  assert.equal(body.status, "in_progress");
  assert.deepEqual(body.ref_ids, ["geneso:whoami/spec/foo.md"]);
});

test("comment POSTs body to /tickets/{id}/comments", async () => {
  let seen = ""; let body: any;
  const c: GoquestClient = { async request(m, p, b) { seen = `${m} ${p}`; body = b; return { ok: true, status: 201, data: {} }; } };
  await wByName("comment").handler({ id: "t9", body: "looks good" }, c);
  assert.equal(seen, "POST /api/v1/tickets/t9/comments");
  assert.equal(body.body, "looks good");
});

test("create_ticket surfaces isError and hint on failure", async () => {
  const c: GoquestClient = { async request() { return { ok: false, status: 404, error: "Not found: x." }; } };
  const r = await wByName("create_ticket").handler({ title: "t", title_name: "goq-t" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});

test("update_ticket surfaces isError and hint on failure", async () => {
  const c: GoquestClient = { async request() { return { ok: false, status: 404, error: "Not found: x." }; } };
  const r = await wByName("update_ticket").handler({ id: "t9", status: "in_progress" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});

test("comment surfaces isError and hint on failure", async () => {
  const c: GoquestClient = { async request() { return { ok: false, status: 404, error: "Not found: x." }; } };
  const r = await wByName("comment").handler({ id: "t9", body: "hi" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});

test("register_vcs_repo POSTs mapped body", async () => {
  let seen = ""; let body: any;
  const c: GoquestClient = { async request(m, p, b) { seen = `${m} ${p}`; body = b; return { ok: true, status: 201, data: { id: "r1" } }; } };
  await vByName("register_vcs_repo").handler(
    { provider: "github", repo_full_name: "tojiuni/goquest", project: "goquest", workspace: "toji", auto_transition: true, merge_target: "completed" },
    c,
  );
  assert.equal(seen, "POST /api/v1/vcs/repos");
  assert.equal(body.repo_full_name, "tojiuni/goquest");
  assert.equal(body.project, "goquest");
  assert.equal(body.merge_target, "completed");
});
