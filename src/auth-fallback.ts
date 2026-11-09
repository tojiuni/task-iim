import { AsyncLocalStorage } from "node:async_hooks";

// Step 1: logging only; shared by all API calls within a tool invocation.
export const currentTool = new AsyncLocalStorage<string>();

export function logAuthFallback(
  reason: "jwt_401" | "no_authorization",
  path: string,
  tool?: string,
  blocked = false,
): void {
  process.stderr.write(JSON.stringify({
    event: blocked ? "auth_fallback_blocked" : "auth_fallback",
    reason, tool, path, ts: new Date().toISOString(),
  }) + "\n");
}
