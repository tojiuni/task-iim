// Step 2: default-off policy, kept separate from fallback observability.
export function apiKeyFallbackAllowed(value = process.env["ALLOW_APIKEY_FALLBACK"]): boolean {
  return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}

export function apiKeyJwtRetryAllowed(value = process.env["ALLOW_APIKEY_JWT_RETRY"]): boolean {
  return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}
