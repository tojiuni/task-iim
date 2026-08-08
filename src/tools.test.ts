import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoquestClient, GqResult } from "./client.ts";
import { readTools, writeTools, projectTools, vcsTools } from "./tools.ts";

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

test("list_tickets sends a default limit when the caller omits one", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = p; return { ok: true, status: 200, data: { tickets: [] } }; });
  await byName("list_tickets").handler({ project_id: "p1" }, c);
  assert.match(seen, /limit=20/);
});

test("list_tickets forwards an explicit limit instead of the default", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = p; return { ok: true, status: 200, data: { tickets: [] } }; });
  await byName("list_tickets").handler({ project_id: "p1", limit: 5 }, c);
  assert.match(seen, /limit=5/);
  assert.doesNotMatch(seen, /limit=20/);
});

test("list_tickets strips heavy fields like description by default (summary mode)", async () => {
  const c = stubClient(() => ({
    ok: true,
    status: 200,
    data: { tickets: [{ id: "t1", title: "Do X", status: "pending", priority: "normal", type: "task", description: "a".repeat(2000) }] },
  }));
  const r = await byName("list_tickets").handler({ project_id: "p1" }, c);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.tickets[0].id, "t1");
  assert.equal(parsed.tickets[0].title, "Do X");
  assert.equal(parsed.tickets[0].description, undefined);
});

test("list_tickets returns full ticket objects when summary=false", async () => {
  const c = stubClient(() => ({
    ok: true,
    status: 200,
    data: { tickets: [{ id: "t1", title: "Do X", description: "full body text" }] },
  }));
  const r = await byName("list_tickets").handler({ project_id: "p1", summary: false }, c);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.tickets[0].description, "full body text");
});

test("get_ticket returns the full object (including description) by default", async () => {
  const c = stubClient(() => ({ ok: true, status: 200, data: { id: "abc", title: "T", description: "full body text" } }));
  const r = await byName("get_ticket").handler({ id: "abc" }, c);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.description, "full body text");
});

test("get_ticket strips heavy fields when summary=true", async () => {
  const c = stubClient(() => ({ ok: true, status: 200, data: { id: "abc", title: "T", status: "pending", description: "full body text" } }));
  const r = await byName("get_ticket").handler({ id: "abc", summary: true }, c);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.id, "abc");
  assert.equal(parsed.title, "T");
  assert.equal(parsed.description, undefined);
});

test("get_ticket_by_name strips heavy fields when summary=true", async () => {
  const c = stubClient(() => ({ ok: true, status: 200, data: { id: "abc", title: "T", description: "full body text" } }));
  const r = await byName("get_ticket_by_name").handler({ title_name: "goq-x", summary: true }, c);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.description, undefined);
});

test("list_comments calls GET /api/v1/tickets/{id}/comments", async () => {
  let seen = "";
  const c = stubClient((m, p) => { seen = `${m} ${p}`; return { ok: true, status: 200, data: { comments: [] } }; });
  const r = await byName("list_comments").handler({ id: "abc" }, c);
  assert.equal(seen, "GET /api/v1/tickets/abc/comments");
  assert.match(r.content[0].text, /"comments": \[\]/);
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

test("create_ticket includes start_at/due_at in the POST body when given", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler(
    { title: "Do X", title_name: "goq-do-x", start_at: "2026-08-10T00:00:00Z", due_at: "2026-08-15T00:00:00Z" },
    c,
  );
  assert.equal(body.start_at, "2026-08-10T00:00:00Z");
  assert.equal(body.due_at, "2026-08-15T00:00:00Z");
});

test("create_ticket omits start_at/due_at from the POST body when not given", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 201, data: { id: "n1" } }; } };
  await wByName("create_ticket").handler({ title: "Do X", title_name: "goq-do-x" }, c);
  assert.equal(body.start_at, undefined);
  assert.equal(body.due_at, undefined);
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

test("reopen_ticket POSTs id + reason to /tickets/{id}/reopen", async () => {
  let seen = ""; let body: any;
  const c: GoquestClient = {
    async request(m, p, b) { seen = `${m} ${p}`; body = b; return { ok: true, status: 200, data: { id: "t9", status: "in_progress" } }; },
  };
  const r = await wByName("reopen_ticket").handler({ id: "t9", reason: "closed in error" }, c);
  assert.equal(seen, "POST /api/v1/tickets/t9/reopen");
  assert.deepEqual(body, { reason: "closed in error" });
  assert.equal(r.isError, undefined);
});

test("reopen_ticket surfaces isError and hint on failure (e.g. not terminal)", async () => {
  const c: GoquestClient = {
    async request() { return { ok: false, status: 422, error: "Unprocessable (likely an invalid status transition): only completed or cancelled tickets can be reopened (current: in_progress)." }; },
  };
  const r = await wByName("reopen_ticket").handler({ id: "t9", reason: "oops" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only completed or cancelled tickets can be reopened/);
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

const pByName = (n: string) => {
  const t = projectTools.find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return t;
};

const WORKSPACES_RESPONSE: GqResult = {
  ok: true,
  status: 200,
  data: { workspaces: [{ id: "ws-toji", name: "toji", slug: "toji-1604dd" }] },
};

test("create_project resolves workspace by name then POSTs to /workspaces/{wid}/projects", async () => {
  const calls: Array<{ m: string; p: string; b?: unknown }> = [];
  const c: GoquestClient = {
    async request(m, p, b) {
      calls.push({ m, p, b });
      if (p === "/api/v1/workspaces") return WORKSPACES_RESPONSE;
      return { ok: true, status: 201, data: { id: "pj1", name: "proprio-mcp" } };
    },
  };
  const r = await pByName("create_project").handler({ name: "proprio-mcp", description: "desc", workspace: "toji" }, c);
  assert.equal(calls[0].p, "/api/v1/workspaces");
  assert.equal(calls[1].m, "POST");
  assert.equal(calls[1].p, "/api/v1/workspaces/ws-toji/projects");
  assert.deepEqual(calls[1].b, { name: "proprio-mcp", description: "desc" });
  assert.equal(r.isError, undefined);
});

test("create_project errors clearly when workspace name has no match", async () => {
  const c: GoquestClient = { async request() { return WORKSPACES_RESPONSE; } };
  const r = await pByName("create_project").handler({ name: "x", workspace: "nope" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found: workspace nope/);
});

test("create_project errors when neither workspace nor workspace_slug is given", async () => {
  const c: GoquestClient = { async request() { throw new Error("should not be called"); } };
  const r = await pByName("create_project").handler({ name: "x" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /workspace or workspace_slug is required/);
});

test("list_projects resolves workspace by slug then GETs its projects", async () => {
  const calls: Array<{ m: string; p: string }> = [];
  const c: GoquestClient = {
    async request(m, p) {
      calls.push({ m, p });
      if (p === "/api/v1/workspaces") return WORKSPACES_RESPONSE;
      return { ok: true, status: 200, data: { projects: [] } };
    },
  };
  await pByName("list_projects").handler({ workspace_slug: "toji-1604dd" }, c);
  assert.equal(calls[1].p, "/api/v1/workspaces/ws-toji/projects");
});

test("get_project by id resolves workspace then GETs the nested project route", async () => {
  const calls: Array<{ m: string; p: string }> = [];
  const c: GoquestClient = {
    async request(m, p) {
      calls.push({ m, p });
      if (p === "/api/v1/workspaces") return WORKSPACES_RESPONSE;
      return { ok: true, status: 200, data: { id: "pj1" } };
    },
  };
  await pByName("get_project").handler({ id: "pj1", workspace: "toji" }, c);
  assert.equal(calls[1].p, "/api/v1/workspaces/ws-toji/projects/pj1");
});

test("get_project by name resolves workspace + project id then GETs the project", async () => {
  const calls: Array<{ m: string; p: string }> = [];
  const c: GoquestClient = {
    async request(m, p) {
      calls.push({ m, p });
      if (p === "/api/v1/workspaces") return WORKSPACES_RESPONSE;
      if (p === "/api/v1/workspaces/ws-toji/projects") {
        return { ok: true, status: 200, data: { projects: [{ id: "pj1", name: "proprio-mcp" }] } };
      }
      return { ok: true, status: 200, data: { id: "pj1", name: "proprio-mcp" } };
    },
  };
  await pByName("get_project").handler({ name: "proprio-mcp", workspace: "toji" }, c);
  assert.equal(calls.at(-1)?.p, "/api/v1/workspaces/ws-toji/projects/pj1");
});

test("get_project errors clearly when name has no match in the workspace", async () => {
  const c: GoquestClient = {
    async request(_m, p) {
      if (p === "/api/v1/workspaces") return WORKSPACES_RESPONSE;
      return { ok: true, status: 200, data: { projects: [] } };
    },
  };
  const r = await pByName("get_project").handler({ name: "nope", workspace: "toji" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found: project nope/);
});

test("get_project errors when neither id nor name is given", async () => {
  const c: GoquestClient = { async request() { throw new Error("should not be called"); } };
  const r = await pByName("get_project").handler({ workspace: "toji" }, c);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /either id or name is required/);
});

test("update_ticket includes project_id (ticket-move) in the PATCH body", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 200, data: {} }; } };
  await wByName("update_ticket").handler({ id: "t1", project_id: "pj2" }, c);
  assert.equal(body.project_id, "pj2");
});

test("update_ticket includes start_at/due_at in the PATCH body when given", async () => {
  let body: any;
  const c: GoquestClient = { async request(_m, _p, b) { body = b; return { ok: true, status: 200, data: {} }; } };
  await wByName("update_ticket").handler({ id: "t1", start_at: "2026-08-10T00:00:00Z", due_at: "2026-08-15T00:00:00Z" }, c);
  assert.equal(body.start_at, "2026-08-10T00:00:00Z");
  assert.equal(body.due_at, "2026-08-15T00:00:00Z");
});
