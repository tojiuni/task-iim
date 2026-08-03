// In-process smoke test: builds the server against a stub client and exercises
// each tool handler, then verifies buildServer wires without throwing.
import assert from "node:assert/strict";
import { buildServer } from "../src/goquest-mcp-server.ts";
import { readTools, writeTools, projectTools, vcsTools } from "../src/tools.ts";
import { apiTools } from "../src/api-tools.ts";
import { guideTools } from "../src/guide.ts";
import type { GoquestClient } from "../src/client.ts";

const stub: GoquestClient = {
  async request(method, path) {
    if (path.includes("/openapi.json")) return { ok: true, status: 200, data: { openapi: "3.1.0", paths: { "/tickets": { get: { summary: "List" } } } } };
    if (path === "/api/v1/workspaces") return { ok: true, status: 200, data: { workspaces: [{ id: "w1", name: "w", slug: "w" }] } };
    if (path.endsWith("/projects")) return { ok: true, status: 200, data: { projects: [{ id: "p1", name: "p" }] } };
    return { ok: true, status: 200, data: { method, path } };
  },
};

// This array must track every tool group buildServer registers (see
// src/goquest-mcp-server.ts) — the count assertion below exists precisely to
// catch a group silently left out here (projectTools was, until this fix).
const all = [...readTools, ...writeTools, ...projectTools, ...apiTools, ...guideTools, ...vcsTools];
assert.equal(all.length, 15, `expected 15 tools, got ${all.length}`);

for (const t of all) {
  const sampleArgs: Record<string, any> = {
    get_ticket: { id: "x" },
    get_ticket_by_name: { title_name: "goq-x", workspace: "w", project: "p" },
    list_tickets: {},
    create_ticket: { title: "t", title_name: "goq-t", project_id: "p" },
    update_ticket: { id: "x", status: "assigned" },
    reopen_ticket: { id: "x", reason: "smoke test" },
    split_text_into_subtasks: { parent_id: "x", text: "smoke test content" },
    comment: { id: "x", body: "hi" },
    create_project: { name: "p", workspace: "w" },
    list_projects: { workspace: "w" },
    get_project: { id: "p1", workspace: "w" },
    list_api: {},
    ticket_guide: {},
    register_vcs_repo: { repo_full_name: "tojiuni/goquest", project: "goquest" },
    list_vcs_repos: {},
  }[t.name] ?? {};
  const r = await t.handler(sampleArgs, stub);
  assert.ok(r.content[0].text.length > 0, `${t.name} returned empty`);
}

// buildServer must wire all tools + the resource without throwing.
buildServer(stub);
process.stdout.write(`smoke ok: ${all.length} tools\n`);
