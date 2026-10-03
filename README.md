# task-iim

MCP server exposing ticket/task operations to LLM agents. Currently proxies the goquest
REST/OpenAPI contract (Phase 1); named generically so other ticket/task backends (e.g.
Jira) can be plugged in later. Renamed from `goquest-mcp`/`goquest-iim` per the `iim`(이음)
service-interface naming convention (`neunexus/reference/iim-convention.md`).

## Tools
- `create_ticket` (idempotent on title_name), `get_ticket`, `get_ticket_by_name`,
  `list_tickets`, `update_ticket`, `reopen_ticket`, `comment`
- `split_text_into_subtasks` — split text into child tickets under a parent_id via cogito
- `decompose_question_into_subtasks` — split a chat question (+ optional history) into child tickets under a parent_id via cogito
- `list_api` — discover goquest API operations (condensed or `full`)
- `ticket_guide` — ticket authoring conventions (also resource `task-iim://ticket-guide`)

## Config
- `GOQUEST_API_URL` (default in-cluster goquest-service)
- `GOQUEST_API_KEY` (from Vault `secret/neunexus/workspace/goquest#api_key`)
- `MCP_HTTP_PORT` (set → StreamableHTTP; unset → stdio)

## Run
```bash
npm install
GOQUEST_API_KEY=... npm start        # stdio
GOQUEST_API_KEY=... MCP_HTTP_PORT=8080 npm start   # HTTP
```

## Register (~/.mcp.json)
```json
{ "mcpServers": { "task": { "command": "npx", "args": ["tsx", "src/task-mcp-server.ts"], "env": { "GOQUEST_API_KEY": "..." } } } }
```

## Guide sync
`ticket-guide.md` is a synced copy of geneso `goquest/guide/ticket-authoring-guide.md`
(source of truth). Edit geneso, then re-copy.
