import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { createClient, type GoquestClient } from "./client.ts";
import { readTools, writeTools, projectTools, vcsTools } from "./tools.ts";
import { apiTools } from "./api-tools.ts";
import { guideTools, GUIDE_TEXT } from "./guide.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

const BASE_URL = (process.env["GOQUEST_API_URL"]?.trim() || "http://goquest-service.goquest.svc.cluster.local:8080").replace(/\/$/, "");
const API_KEY = process.env["GOQUEST_API_KEY"]?.trim() ?? "";

export function buildServer(client: GoquestClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const t of [...readTools, ...writeTools, ...projectTools, ...apiTools, ...guideTools, ...vcsTools]) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, (args: any) => t.handler(args, client));
  }
  // Also expose the guide as a readable resource.
  server.registerResource(
    "ticket-guide",
    "goquest://ticket-guide",
    { title: "goquest ticket authoring guide", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_TEXT }] }),
  );
  return server;
}

async function main() {
  if (!API_KEY) process.stderr.write("warning: GOQUEST_API_KEY is empty; auth header from MCP session will be used for per-user identity\n");
  const httpPort = process.env["MCP_HTTP_PORT"] ? parseInt(process.env["MCP_HTTP_PORT"], 10) : undefined;
  if (httpPort) {
    createServer(async (req, res) => {
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
      // Anonymous requests (no header) still work — goquest applies anonymous permissions.
      const authHeader = req.headers["authorization"] as string | undefined;
      const client = createClient({ baseUrl: BASE_URL, apiKey: API_KEY, authorizationHeader: authHeader });
      const server = buildServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
    }).listen(httpPort, () => process.stderr.write(`goquest-iim HTTP listening on :${httpPort}\n`));
  } else {
    // stdio mode: no per-request auth context; use static API_KEY if set.
    const client = createClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    const server = buildServer(client);
    await server.connect(new StdioServerTransport());
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && import.meta.url === `file://${entry}`) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
