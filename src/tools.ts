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
