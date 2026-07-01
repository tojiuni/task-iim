import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { createClient, type GoquestClient } from "./client.ts";
import { readTools, writeTools } from "./tools.ts";
import { apiTools } from "./api-tools.ts";
import { guideTools, GUIDE_TEXT } from "./guide.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

const BASE_URL = (process.env["GOQUEST_API_URL"]?.trim() || "http://goquest-service.goquest.svc.cluster.local:8080").replace(/\/$/, "");
const API_KEY = process.env["GOQUEST_API_KEY"]?.trim() ?? "";

export function buildServer(client: GoquestClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const t of [...readTools, ...writeTools, ...apiTools, ...guideTools]) {
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
  if (!API_KEY) process.stderr.write("warning: GOQUEST_API_KEY is empty; goquest calls will 401\n");
  const client = createClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  const server = buildServer(client);
  const httpPort = process.env["MCP_HTTP_PORT"] ? parseInt(process.env["MCP_HTTP_PORT"], 10) : undefined;
  if (httpPort) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    createServer((req, res) => transport.handleRequest(req, res)).listen(httpPort, () =>
      process.stderr.write(`goquest-mcp HTTP listening on :${httpPort}\n`),
    );
    await server.connect(transport);
  } else {
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
