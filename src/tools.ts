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

export const readTools: ToolDef[] = [
  {
    name: "get_ticket",
    description: "Fetch a single ticket by its UUID.",
    inputSchema: { id: z.string().describe("Ticket UUID") },
    handler: async ({ id }, client) => fromResult(await client.request("GET", `/api/v1/tickets/${id}`)),
  },
  {
    name: "get_ticket_by_name",
    description: "Fetch a ticket by its human title_name within a project named by workspace + project (no UUIDs).",
    inputSchema: {
      title_name: z.string().describe("Ticket title_name, e.g. goq-vault-portforward"),
      workspace: z.string().optional().describe("Workspace name"),
      workspace_slug: z.string().optional().describe("Workspace slug (alternative to workspace)"),
      project: z.string().optional().describe("Project name"),
    },
    handler: async ({ title_name, workspace, workspace_slug, project }, client) =>
      fromResult(
        await client.request(
          "GET",
          `/api/v1/tickets/by-name/${encodeURIComponent(title_name)}${qs({ workspace, workspace_slug, project })}`,
        ),
      ),
  },
  {
    name: "list_tickets",
    description: "List tickets with optional filters: title_name (exact), repeatable tag names, status, domain, project_id.",
    inputSchema: {
      project_id: z.string().optional().describe("Project UUID (required when filtering by tag)"),
      title_name: z.string().optional().describe("Exact title_name match"),
      tag: z.array(z.string()).optional().describe("Tag names (repeatable); requires project_id"),
      status: z.string().optional().describe("pending|assigned|in_progress|pending_approval|completed|failed|cancelled"),
      domain: z.string().optional().describe("infra|data|code|monitor|knowledge|pm"),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
    },
    handler: async (a, client) =>
      fromResult(
        await client.request(
          "GET",
          `/api/v1/tickets${qs({
            project_id: a.project_id,
            title_name: a.title_name,
            tag: a.tag,
            status: a.status,
            domain: a.domain,
            limit: a.limit !== undefined ? String(a.limit) : undefined,
            offset: a.offset !== undefined ? String(a.offset) : undefined,
          })}`,
        ),
      ),
  },
];

export const writeTools: ToolDef[] = [
  {
    name: "create_ticket",
    description:
      "Create a ticket. Idempotent: a duplicate title_name in the same project returns the existing ticket (result includes \"replayed\": true). Prefer name-based fields (workspace/project/tag_names) over UUIDs. title_name must match ^[a-z][a-z0-9]*(-[a-z0-9]+)+$ (lowercase, >=1 hyphen). Call ticket_guide for full conventions.",
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
      const r = await client.request("POST", "/api/v1/tickets", body);
      if (!r.ok) return textResult(r.error ?? `HTTP ${r.status}`, true);
      return textResult({ replayed: r.replayed ?? false, ticket: r.data });
    },
  },
  {
    name: "update_ticket",
    description:
      "Update a ticket by UUID. Supports status transitions (pending→assigned→in_progress→completed; pending→in_progress is rejected — go via assigned).",
    inputSchema: {
      id: z.string().describe("Ticket UUID"),
      status: z.string().optional().describe("New status"),
      title: z.string().optional(),
      title_name: z.string().optional(),
      description: z.string().optional(),
      priority: z.string().optional(),
      domain: z.string().optional(),
      assignee_id: z.string().optional(),
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
    name: "comment",
    description: "Add a comment to a ticket.",
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
