import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolDef } from "./tools.ts";
import { textResult } from "./tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
// ticket-guide.md lives at the repo root, one level up from src/.
export const GUIDE_TEXT = readFileSync(join(here, "..", "ticket-guide.md"), "utf8");

export const guideTools: ToolDef[] = [
  {
    name: "ticket_guide",
    description:
      "Return the goquest ticket authoring guide: title_name format, name-based fields, idempotency, dedup/parent procedure, and the status state machine. Read this before creating tickets.",
    inputSchema: {},
    handler: async () => textResult(GUIDE_TEXT),
  },
];
