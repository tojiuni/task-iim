import { z } from "zod";
import type { ToolDef } from "./tools.ts";
import { textResult } from "./tools.ts";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

// condenseOpenAPI turns an OpenAPI doc into "METHOD /path — summary" lines.
export function condenseOpenAPI(spec: any): string[] {
  const out: string[] = [];
  const paths = (spec && spec.paths) || {};
  for (const [path, item] of Object.entries<any>(paths)) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      out.push(`${m.toUpperCase()} ${path} — ${op.summary ?? op.operationId ?? ""}`.trimEnd());
    }
  }
  return out;
}

export const apiTools: ToolDef[] = [
  {
    name: "list_api",
    description:
      "List the goquest ticket API operations (from the served OpenAPI spec). Returns a condensed 'METHOD /path — summary' list by default; pass full=true for the raw OpenAPI JSON.",
    inputSchema: {
      full: z.boolean().optional().describe("Return the raw OpenAPI spec instead of the condensed list"),
    },
    handler: async ({ full }, client) => {
      const r = await client.request("GET", "/api/v1/openapi.json");
      if (!r.ok) return textResult(r.error ?? `HTTP ${r.status}`, true);
      if (full) return textResult(r.data);
      return textResult(condenseOpenAPI(r.data).join("\n"));
    },
  },
];
