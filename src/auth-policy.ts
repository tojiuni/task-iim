// Step 2: default-off policy, kept separate from fallback observability.
export function apiKeyFallbackAllowed(value = process.env["ALLOW_APIKEY_FALLBACK"]): boolean {
  return value === "1";
}
