import { AsyncLocalStorage } from "node:async_hooks";

// Step 1: logging only; shared by all API calls within a tool invocation.
export const currentTool = new AsyncLocalStorage<string>();

// Unverified JWT data is observation only, never an authorization decision.
export function fallbackActor(authorizationHeader?: string): string {
  try {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader ?? "");
    const parts = match?.[1].split(".");
    if (!parts || parts.length !== 3 || !parts[0] || !parts[2]) return "unknown";
    const payload = parts[1];
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return "unknown";
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url")));
    if (!claims || typeof claims.sub !== "string") return "unknown";
    return claims.sub.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 128) || "unknown";
  } catch {
    return "unknown";
  }
}

export function logAuthFallback(
  reason: "jwt_401" | "no_authorization",
  path: string,
  tool?: string,
  blocked = false,
  authorizationHeader?: string,
): void {
  process.stderr.write(JSON.stringify({
    event: blocked ? "auth_fallback_blocked" : "auth_fallback",
    actor_unverified: fallbackActor(authorizationHeader),
    reason, tool, path: path.split(/[?#]/, 1)[0], ts: new Date().toISOString(),
  }) + "\n");
}
