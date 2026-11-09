import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { currentTool, logAuthFallback } from "./auth-fallback.ts";
import { apiKeyFallbackAllowed } from "./auth-policy.ts";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { createClient, type GoquestClient } from "./client.ts";
import { readTools, writeTools, projectTools, vcsTools, approvalTools, mentionTools } from "./tools.ts";
import { apiTools } from "./api-tools.ts";
import { guideTools, GUIDE_TEXT } from "./guide.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

const BASE_URL = (process.env["GOQUEST_API_URL"]?.trim() || "http://goquest-service.goquest.svc.cluster.local:8080").replace(/\/$/, "");
const API_KEY = process.env["GOQUEST_API_KEY"]?.trim() ?? "";

export function buildServer(client: GoquestClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const t of [...readTools, ...writeTools, ...projectTools, ...apiTools, ...guideTools, ...vcsTools, ...approvalTools, ...mentionTools]) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, (args: any) => currentTool.run(t.name, () => t.handler(args, client)));
  }
  // Also expose the guide as a readable resource.
  server.registerResource(
    "ticket-guide",
    "task-iim://ticket-guide",
    { title: "ticket authoring guide", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_TEXT }] }),
  );
  return server;
}

async function main() {
  if (!API_KEY) process.stderr.write("warning: GOQUEST_API_KEY is empty; auth header from MCP session will be used for per-user identity\n");
  const httpPort = process.env["MCP_HTTP_PORT"] ? parseInt(process.env["MCP_HTTP_PORT"], 10) : undefined;
  if (httpPort) {
    createServer(createHttpHandler()).listen(httpPort, () => process.stderr.write(`task-iim HTTP listening on :${httpPort}\n`));
  } else {
    const client = createClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    const server = buildServer(client);
    await server.connect(new StdioServerTransport());
  }
}

export function createHttpHandler(options: { baseUrl?: string; apiKey?: string; allowApiKeyFallback?: boolean; fetchImpl?: typeof fetch } = {}): import("node:http").RequestListener {
  return async (req, res) => {
    // Lightweight health endpoint for k8s probes. The MCP transport only
    // speaks POST /mcp and 500s a plain GET, so probes must not hit it.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/livez" || req.url === "/readyz")) {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    // Stateless streamable HTTP: a FRESH server + transport per request.
    // A single shared transport with sessionIdGenerator:undefined only ever
    // handles the first request and 500s every subsequent one ("already
    // initialized") — which silently breaks every client after pod start.
    //
    // Per-user JWT auth: extract Authorization from the incoming MCP HTTP
    // request and forward it to goquest API calls so goquest can validate
    // it against JWKS_URL and apply per-user SpiceDB authz.
    const authHeader = req.headers["authorization"];
    const allowApiKeyFallback = options.allowApiKeyFallback ?? apiKeyFallbackAllowed();
    if (!authHeader && !allowApiKeyFallback) {
      logAuthFallback("no_authorization", req.url ?? "/mcp", undefined, true);
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" }, id: null }),
      );
      return;
    }
    let unauthorized = false;
    // JSON mode defers headers until the tool completes. Translate upstream
    // authentication failure at the HTTP boundary, before any bytes are sent.
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: Parameters<typeof writeHead>) {
      if (unauthorized) args[0] = 401;
      return writeHead.apply(this, args);
    } as typeof writeHead;
    const client = createClient({
      baseUrl: options.baseUrl ?? BASE_URL, apiKey: options.apiKey ?? API_KEY,
      authorizationHeader: authHeader, allowApiKeyFallback,
      fetchImpl: options.fetchImpl,
      onUnauthorized: () => { unauthorized = true; },
    });
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (unauthorized && "id" in message && ("result" in message || "error" in message)) {
        return send({
          jsonrpc: "2.0", id: message.id,
          error: { code: -32001, message: "Authentication required" },
        }, options);
      }
      return send(message, options);
    };
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      process.stderr.write(`mcp request error: ${String(e)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }),
        );
      }
    }
  };
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && import.meta.url === `file://${entry}`) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
