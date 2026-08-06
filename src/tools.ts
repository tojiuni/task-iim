import { z } from "zod";
import type { GoquestClient, GqResult } from "./client.ts";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: any, client: GoquestClient) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
};

export function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

// Shape a GqResult into an MCP tool result: data on success, hint on error.
function fromResult(r: GqResult) {
  if (!r.ok) return textResult(r.error ?? `HTTP ${r.status}`, true);
  return textResult(r.replayed ? { replayed: true, ticket: r.data } : r.data);
}

// Matches "geneso:<path>" tokens embedded in free text (e.g. a ticket
// description that mentions a spec/plan doc inline). The path runs until
// whitespace or a delimiter that's clearly not part of a file path (closing
// backtick/paren/bracket, or a trailing comma/period used as punctuation).
const GENESO_REF_RE = /geneso:[^\s`)\],]+/g;

// Auto-extracts geneso: refs mentioned in free text and merges them with any
// explicitly-passed ref_ids, de-duplicated, explicit refs first. Returns
// undefined when there's nothing to link, so callers can omit the field
// entirely (matches the API's "omit for none" convention) rather than
// sending an empty array.
function mergeRefIds(explicit: string[] | undefined, description: string | undefined): string[] | undefined {
  const fromText = description ? [...new Set(description.match(GENESO_REF_RE) ?? [])] : [];
  const merged = [...new Set([...(explicit ?? []), ...fromText])];
  return merged.length ? merged : undefined;
}

// Default page size for list_tickets when the caller omits `limit` — the
// REST backend's own default isn't part of this tool's contract, so it's
// enforced here explicitly.
const DEFAULT_LIST_LIMIT = 20;

// Fields kept by the lean/"summary" ticket projection: enough to identify a
// ticket and act on it, without the heavy free-text body (description) or
// any other bulky field the backend might attach.
const LEAN_TICKET_FIELDS = [
  "id",
  "title",
  "title_name",
  "status",
  "priority",
  "type",
  "domain",
  "project_id",
  "workspace_id",
  "parent_id",
  "tags",
  "tag_names",
  "assignee_id",
  "created_at",
  "updated_at",
] as const;

// leanTicket strips heavy fields (notably `description`) from a ticket
// object, keeping only the identifying fields above. Non-object input is
// returned unchanged.
function leanTicket(ticket: unknown): unknown {
  if (!ticket || typeof ticket !== "object") return ticket;
  const src = ticket as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of LEAN_TICKET_FIELDS) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

// leanTicketList applies leanTicket across a list_tickets response, which is
// an envelope ({ tickets: [...], ... }) rather than a bare array — other
// envelope fields (total, limit, offset, ...) pass through untouched.
function leanTicketList(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(leanTicket);
  if (data && typeof data === "object" && Array.isArray((data as any).tickets)) {
    return { ...(data as Record<string, unknown>), tickets: (data as any).tickets.map(leanTicket) };
  }
  return data;
}

function qs(params: Record<string, string | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, item));
    else sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// goquest has no name-based project endpoints (unlike tickets' /by-name/
// route), so project tools resolve workspace/project names to UUIDs
// client-side by listing and matching. Returns a GqResult-shaped error on
// no-match/ambiguous-match so callers can pass it straight to fromResult.
async function resolveWorkspaceId(
  client: GoquestClient,
  { workspace, workspace_slug }: { workspace?: string; workspace_slug?: string },
): Promise<{ id: string } | { error: GqResult }> {
  if (!workspace && !workspace_slug) {
    return { error: { ok: false, status: 400, error: "Bad request: workspace or workspace_slug is required." } };
  }
  const r = await client.request("GET", "/api/v1/workspaces");
  if (!r.ok) return { error: r };
  const list = (r.data as { workspaces?: Array<{ id: string; name: string; slug: string }> })?.workspaces ?? [];
  const match = list.find((w) => (workspace_slug ? w.slug === workspace_slug : w.name === workspace));
  if (!match) {
    return { error: { ok: false, status: 404, error: `Not found: workspace ${workspace_slug ?? workspace}.` } };
  }
  return { id: match.id };
}

async function resolveProjectId(
  client: GoquestClient,
  workspaceId: string,
  projectName: string,
): Promise<{ id: string } | { error: GqResult }> {
  const r = await client.request("GET", `/api/v1/workspaces/${workspaceId}/projects`);
  if (!r.ok) return { error: r };
  const list = (r.data as { projects?: Array<{ id: string; name: string }> })?.projects ?? [];
  const match = list.find((p) => p.name === projectName);
  if (!match) return { error: { ok: false, status: 404, error: `Not found: project ${projectName}.` } };
  return { id: match.id };
}

export const readTools: ToolDef[] = [
  {
    name: "get_ticket",
    description:
      "Fetch a single ticket by its UUID. Returns the full object (including description) by default; pass summary=true for a lean projection (id/title/status/... without description) when you only need a quick check.",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
      summary: z.boolean().optional().describe("Return a lean projection (drops description and other heavy fields). Default false."),
    },
    handler: async ({ id, summary }, client) => {
      const r = await client.request("GET", `/api/v1/tickets/${id}`);
      if (summary && r.ok) return fromResult({ ...r, data: leanTicket(r.data) });
      return fromResult(r);
    },
  },
  {
    name: "get_ticket_by_name",
    description:
      "Fetch a ticket by its human title_name within a project named by workspace + project (no UUIDs). Returns the full object (including description) by default; pass summary=true for a lean projection.",
    inputSchema: {
      title_name: z.string().describe("Ticket title_name, e.g. goq-vault-portforward"),
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug (alternative to workspace)"),
      project: z.string().optional().describe("Project name"),
      summary: z.boolean().optional().describe("Return a lean projection (drops description and other heavy fields). Default false."),
    },
    handler: async ({ title_name, workspace, workspace_slug, project, summary }, client) => {
      const r = await client.request(
        "GET",
        `/api/v1/tickets/by-name/${encodeURIComponent(title_name)}${qs({ workspace, workspace_slug, project })}`,
      );
      if (summary && r.ok) return fromResult({ ...r, data: leanTicket(r.data) });
      return fromResult(r);
    },
  },
  {
    name: "list_tickets",
    description:
      "List tickets with optional filters: title_name (exact), repeatable tag names, status, domain, project_id. " +
      `Defaults to a lean/summary projection per ticket (id/title/status/priority/type/... without description) and a limit of ${DEFAULT_LIST_LIMIT} when omitted, to keep results small; pass summary=false for full ticket objects.`,
    inputSchema: {
      project_id: z.string().optional().describe("Project UUID (required when filtering by tag)"),
      title_name: z.string().optional().describe("Exact title_name match"),
      tag: z.array(z.string()).optional().describe("Tag names (repeatable); requires project_id"),
      status: z.string().optional().describe("pending|assigned|in_progress|pending_approval|completed|failed|cancelled|on_hold"),
      domain: z.string().optional().describe("infra|data|code|monitor|knowledge|pm"),
      limit: z.number().int().optional().describe(`Max results. Defaults to ${DEFAULT_LIST_LIMIT} when omitted.`),
      offset: z.number().int().optional(),
      summary: z
        .boolean()
        .optional()
        .describe("Strip heavy fields (description, ...) from each ticket. Default true — pass false for full objects."),
    },
    handler: async (a, client) => {
      const limit = a.limit !== undefined ? a.limit : DEFAULT_LIST_LIMIT;
      const summary = a.summary !== undefined ? a.summary : true;
      const r = await client.request(
        "GET",
        `/api/v1/tickets${qs({
          project_id: a.project_id,
          title_name: a.title_name,
          tag: a.tag,
          status: a.status,
          domain: a.domain,
          limit: String(limit),
          offset: a.offset !== undefined ? String(a.offset) : undefined,
        })}`,
      );
      if (summary && r.ok) return fromResult({ ...r, data: leanTicketList(r.data) });
      return fromResult(r);
    },
  },
  {
    name: "list_comments",
    description:
      "List comments on a ticket, oldest first. Use this to read what another session/agent already said before acting on a ticket — e.g. verifying a completion comment's stated reasoning before trusting it. Internal-only comments (is_internal=true) are included only for staff-scoped API keys; customer-scoped keys only ever see external comments.",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
    },
    handler: async ({ id }, client) => fromResult(await client.request("GET", `/api/v1/tickets/${id}/comments`)),
  },
];

export const writeTools: ToolDef[] = [
  {
    name: "create_ticket",
    description:
      "Create a ticket. Idempotent: a duplicate title_name in the same project returns the existing ticket (result includes \"replayed\": true). Prefer name-based fields (workspace/project/tag_names) over UUIDs. title_name must match ^[a-z][a-z0-9]*(-[a-z0-9]+)+$ (lowercase, >=1 hyphen). ALWAYS link the source design/plan/spec doc(s) via ref_ids (e.g. geneso:whoami/spec/foo.md); for sub-tickets, inherit the parent's ref_ids. As a safety net, any \"geneso:<path>\" token mentioned inline in description is also auto-extracted and merged into ref_ids (deduplicated) — but still pass ref_ids explicitly rather than relying on this, since it only catches the exact \"geneso:\" prefix form. Call ticket_guide for full conventions. Name your git branch with the title_name (e.g. goq-foo or feature/goq-foo) and put the title_name in PR titles/commit messages — goquest then auto-links branches/commits/PRs to this ticket and advances its status.",
    inputSchema: {
      title: z.string().describe("Human-readable title (required)"),
      title_name: z.string().optional().describe("Stable handle, e.g. goq-vault-portforward (lowercase, >=1 hyphen)"),
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug"),
      project: z.string().optional().describe("Project name"),
      project_id: z.string().optional().describe("Project UUID (alternative to project name)"),
      tag_names: z.array(z.string()).optional().describe("Tag names; missing tags are auto-created"),
      type: z.enum(["task", "bug", "feature", "incident", "request"]).optional(),
      priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
      domain: z.enum(["infra", "data", "code", "monitor", "knowledge", "pm"]).optional(),
      parent_id: z.string().optional().describe("Parent ticket UUID for sub-tickets"),
      ref_ids: z
        .array(z.string())
        .optional()
        .describe("Related source docs to link, e.g. [\"geneso:whoami/spec/foo.md\", \"<repo>/docs/plans/bar.md\"]. Link the design/plan/spec that motivated the ticket; sub-tickets inherit the parent's refs. Each <=512 chars, no duplicates."),
      description: z.string().optional(),
    },
    handler: async (a, client) => {
      const body: Record<string, unknown> = { title: a.title };
      if (a.title_name) body.title_name = a.title_name;
      if (a.workspace) body.workspace_name = a.workspace;
      if (a.workspace_slug) body.workspace_slug = a.workspace_slug;
      if (a.project) body.project_name = a.project;
      if (a.project_id) body.project_id = a.project_id;
      if (a.tag_names) body.tag_names = a.tag_names;
      if (a.type) body.type = a.type;
      if (a.priority) body.priority = a.priority;
      if (a.domain) body.domain = a.domain;
      if (a.parent_id) body.parent_id = a.parent_id;
      if (a.description) body.description = a.description;
      const refIds = mergeRefIds(a.ref_ids, a.description);
      if (refIds) body.ref_ids = refIds;
      const r = await client.request("POST", "/api/v1/tickets", body);
      if (!r.ok) return textResult(r.error ?? `HTTP ${r.status}`, true);
      return textResult({ replayed: r.replayed ?? false, ticket: r.data });
    },
  },
  {
    name: "update_ticket",
    description:
      "Update a ticket by UUID. Supports status transitions (pending→assigned→in_progress→completed; pending→in_progress is rejected — go via assigned). completed/cancelled are terminal — status here can NEVER move a ticket out of them (always rejected, by design); use reopen_ticket instead. ref_ids REPLACES the ticket's linked docs (send the full desired set, not a delta). project_id moves the ticket to another project (target project must exist — use create_project first if it doesn't). IMPORTANT: for work that produces no git branch/commit/PR (evaluation, investigation, docs-only tickets), VCS auto-link never fires, so completing the work does NOT transition the status by itself — call update_ticket(status=\"completed\") yourself. A \"comment\" documenting completion is not a status change.",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
      status: z.string().optional().describe("New status"),
      title: z.string().optional(),
      title_name: z.string().optional(),
      description: z.string().optional(),
      priority: z.string().optional(),
      domain: z.string().optional(),
      assignee_id: z.string().optional(),
      project_id: z.string().optional().describe("Move the ticket to a different project (target project UUID)"),
      ref_ids: z
        .array(z.string())
        .optional()
        .describe("Replace linked source docs with this full set, e.g. [\"geneso:whoami/spec/foo.md\"]. Each <=512 chars, no duplicates."),
    },
    handler: async (a, client) => {
      const { id, ...rest } = a;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      const r = await client.request("PATCH", `/api/v1/tickets/${id}`, body);
      return fromResult(r);
    },
  },
  {
    name: "reopen_ticket",
    description:
      "Move a completed or cancelled ticket back to in_progress. This is the ONLY way out of a terminal status — update_ticket(status=...) always rejects transitions out of completed/cancelled (by design; terminals must go through this audited escape hatch). reason is required and is recorded in the audit log (e.g. \"closed in error by a VCS auto-link false positive\", \"reopened per requester\").",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
      reason: z.string().describe("Why this terminal ticket is being reopened (required, audit-logged)"),
    },
    handler: async ({ id, reason }, client) => {
      const r = await client.request("POST", `/api/v1/tickets/${id}/reopen`, { reason });
      return fromResult(r);
    },
  },
  {
    name: "split_text_into_subtasks",
    description:
      "Split free-form text into child tickets under parent_id: goquest runs cogito's SplitContent pipeline on text and bulk-creates the resulting sections as real sub-tickets of parent_id. Only parent_id is needed — no workspace/project name resolution required (unlike create_ticket). Returns per-section results (index, id, ok, error?) plus a created count; partial failures are possible, check each result's ok.",
    inputSchema: {
      parent_id: z.string().describe("Parent ticket UUID to create sub-tickets under"),
      text: z.string().min(1).describe("Free-form text to split into sub-tickets (required, non-empty)"),
      title: z.string().optional().describe("Optional title hint for the split, e.g. used as a prefix for section titles"),
    },
    handler: async ({ parent_id, text, title }, client) => {
      const body: Record<string, unknown> = { text };
      if (title !== undefined) body.title = title;
      const r = await client.request("POST", `/api/v1/tickets/${parent_id}/subtasks/from-text`, body);
      return fromResult(r);
    },
  },
  {
    name: "decompose_question_into_subtasks",
    description:
      "Split a chat question into child tickets under parent_id: goquest runs cogito's DecomposeQuestion pipeline (mode=task-candidates) on the message (plus optional history) and bulk-creates the resulting task candidates as real sub-tickets of parent_id. Only parent_id is needed — no workspace/project name resolution required (unlike create_ticket). Returns per-candidate results (index, id, ok, error?) plus a created count; partial failures are possible, check each result's ok.",
    inputSchema: {
      parent_id: z.string().describe("Parent ticket UUID to create sub-tickets under"),
      message: z.string().min(1).describe("Chat question/message to decompose into sub-tickets (required, non-empty)"),
      history: z
        .array(z.object({ role: z.string(), content: z.string() }))
        .optional()
        .describe("Optional prior chat turns for context, e.g. [{role: \"user\", content: \"...\"}, {role: \"assistant\", content: \"...\"}]"),
    },
    handler: async ({ parent_id, message, history }, client) => {
      const body: Record<string, unknown> = { message };
      if (history && history.length) body.history = history;
      const r = await client.request("POST", `/api/v1/tickets/${parent_id}/subtasks/from-chat`, body);
      return fromResult(r);
    },
  },
  {
    name: "comment",
    description: "Add a comment to a ticket. Note: a comment never changes ticket status — if the work is done, also call update_ticket(status=\"completed\") (PR-less work has no other way to transition).",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
      body: z.string().describe("Comment text"),
    },
    handler: async ({ id, body }, client) => {
      const r = await client.request("POST", `/api/v1/tickets/${id}/comments`, { body });
      return fromResult(r);
    },
  },
];

export const projectTools: ToolDef[] = [
  {
    name: "create_project",
    description:
      "Create a project inside a workspace. NOT idempotent (unlike create_ticket) — call list_projects first to check for an existing project with the same name before creating a duplicate.",
    inputSchema: {
      name: z.string().describe("Project name (required)"),
      description: z.string().optional(),
      difficulty: z.enum(["trivial", "easy", "normal", "hard", "epic"]).optional(),
      reward_xp: z.number().int().optional(),
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug (alternative to workspace)"),
    },
    handler: async (a, client) => {
      const ws = await resolveWorkspaceId(client, { workspace: a.workspace, workspace_slug: a.workspace_slug });
      if ("error" in ws) return fromResult(ws.error);
      const body: Record<string, unknown> = { name: a.name };
      if (a.description !== undefined) body.description = a.description;
      if (a.difficulty !== undefined) body.difficulty = a.difficulty;
      if (a.reward_xp !== undefined) body.reward_xp = a.reward_xp;
      const r = await client.request("POST", `/api/v1/workspaces/${ws.id}/projects`, body);
      return fromResult(r);
    },
  },
  {
    name: "list_projects",
    description: "List projects in a workspace.",
    inputSchema: {
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug (alternative to workspace)"),
    },
    handler: async (a, client) => {
      const ws = await resolveWorkspaceId(client, { workspace: a.workspace, workspace_slug: a.workspace_slug });
      if ("error" in ws) return fromResult(ws.error);
      return fromResult(await client.request("GET", `/api/v1/workspaces/${ws.id}/projects`));
    },
  },
  {
    name: "get_project",
    description:
      "Fetch a project by UUID or by name, within a workspace named by workspace/workspace_slug (goquest has no top-level /projects/{id} route, so the workspace is required either way).",
    inputSchema: {
      id: z.string().optional().describe("Project UUID (alternative to name)"),
      name: z.string().optional().describe("Project name (alternative to id)"),
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug (alternative to workspace)"),
    },
    handler: async (a, client) => {
      if (!a.id && !a.name) {
        return fromResult({ ok: false, status: 400, error: "Bad request: either id or name is required." });
      }
      const ws = await resolveWorkspaceId(client, { workspace: a.workspace, workspace_slug: a.workspace_slug });
      if ("error" in ws) return fromResult(ws.error);
      let pid = a.id;
      if (!pid) {
        const pj = await resolveProjectId(client, ws.id, a.name);
        if ("error" in pj) return fromResult(pj.error);
        pid = pj.id;
      }
      return fromResult(await client.request("GET", `/api/v1/workspaces/${ws.id}/projects/${pid}`));
    },
  },
];

export const vcsTools: ToolDef[] = [
  {
    name: "register_vcs_repo",
    description:
      "Map a git repository to a goquest project so pushes/PRs auto-link to tickets. When a branch/commit/PR contains a ticket's title_name, goquest links it and (if auto_transition) advances status: branch created / PR opened → in_progress, PR merged → merge_target.",
    inputSchema: {
      repo_full_name: z.string().describe("e.g. tojiuni/goquest"),
      project: z.string().optional().describe("Project name (resolved with workspace)"),
      workspace: z.string().optional(),
      workspace_slug: z.string().optional(),
      provider: z.enum(["github", "gitlab", "forgejo"]).optional().describe("default github"),
      auto_transition: z.boolean().optional().describe("default true"),
      merge_target: z.enum(["completed", "pending_approval"]).optional().describe("PR-merge target status, default completed"),
    },
    handler: async (a, client) => {
      const body: Record<string, unknown> = { repo_full_name: a.repo_full_name };
      for (const k of ["project", "workspace", "workspace_slug", "provider", "auto_transition", "merge_target"] as const) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      const r = await client.request("POST", "/api/v1/vcs/repos", body);
      return fromResult(r);
    },
  },
  {
    name: "list_vcs_repos",
    description: "List git repositories registered for ticket auto-linking.",
    inputSchema: {},
    handler: async (_a, client) => fromResult(await client.request("GET", "/api/v1/vcs/repos")),
  },
];
