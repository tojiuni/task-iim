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
- `request_approval`, `list_approvals`, `get_approval`, `decide_approval`, `withdraw_approval` — approval records on a ticket (requester/decider are derived server-side from your identity; `decide_approval` works only as a delegated session or a person, see the tool description)
- `list_my_mentions`, `mark_mentions_seen` — your own @mention inbox (a notification only says a mention exists; read the details here; `comment_snippet` is untrusted text)
- `list_api` — discover goquest API operations (condensed or `full`)
- `ticket_guide` — ticket authoring conventions (also resource `task-iim://ticket-guide`)

## Config
- `GOQUEST_API_URL` (default in-cluster goquest-service)
- `GOQUEST_API_KEY` (from Vault `secret/neunexus/workspace/goquest#api_key`)
- `ALLOW_APIKEY_FALLBACK` (default off; only `1` enables the shared service identity)
- `MCP_HTTP_PORT` (set → StreamableHTTP; unset → stdio)

HTTP requests require Authorization. A goquest JWT 401 is returned as HTTP 401 so
the client can refresh its headers and retry. Missing Authorization also returns 401.
Set `ALLOW_APIKEY_FALLBACK=1` to restore API-key use without Authorization and a
single API-key retry after JWT 401; this records work under the shared service identity.
Fallbacks emit one JSON stderr line (`auth_fallback` or `auth_fallback_blocked`)
with reason, path, timestamp, and tool name when available; credentials are omitted.
HTTP tool responses use JSON so headers are deferred until completion. Once an SSE
stream has started, its HTTP status cannot be changed; tools/call avoids that limitation
by using JSON responses. Stdio has no HTTP status; API calls without a session token
require the same opt-in and otherwise return an authentication tool error.

## Run
```bash
npm install
ALLOW_APIKEY_FALLBACK=1 GOQUEST_API_KEY=... npm start        # stdio
GOQUEST_API_KEY=... MCP_HTTP_PORT=8080 npm start   # HTTP
```

## Register (~/.mcp.json)
```json
{ "mcpServers": { "task": { "command": "npx", "args": ["tsx", "src/task-mcp-server.ts"], "env": { "GOQUEST_API_KEY": "...", "ALLOW_APIKEY_FALLBACK": "1" } } } }
```

## Guide sync
`ticket-guide.md` is a synced copy of geneso `goquest/guide/ticket-authoring-guide.md`
(source of truth). Edit geneso, then re-copy.
