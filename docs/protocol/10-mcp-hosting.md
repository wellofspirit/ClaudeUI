# 10 — MCP hosting

How we host in-process MCP servers and handle `mcp_message` control requests from cli.js. Covers the four MCP server types cli.js supports, the `--mcp-config` JSON schema, the `mcp_message` wire protocol, and the server lifecycle.

See `src/main/sdk/mcp-host.ts`, `src/main/sdk/create-sdk-mcp.ts`.

---

## 10.1 Four server types

cli.js supports four kinds of MCP servers, discriminated by `type`:

### `stdio` — child process with JSON-RPC over stdin/stdout

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
  "env": { "FOO": "bar" }
}
```

cli.js spawns the process, speaks JSON-RPC 2.0 over stdio. Standard MCP pattern.

### `http` — remote MCP server over HTTP

```json
{
  "type": "http",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

cli.js posts JSON-RPC requests via HTTPS (implementation uses `undici`).

### `sse` — remote MCP server over Server-Sent Events

```json
{
  "type": "sse",
  "url": "https://example.com/mcp/sse",
  "headers": { "Authorization": "Bearer <token>" }
}
```

### `sdk` — in-process, hosted by the SDK harness

```ts
{
  type: 'sdk',
  name: 'claude-ui',
  version: '0.0.0',
  tools: [...],
  instance: <McpServer>,  // from @modelcontextprotocol/sdk
}
```

These are **never** written to `--mcp-config`. They're hosted by our process and referenced by name in the initialize payload (`sdkMcpServers: ['claude-ui', 'claude-ui-mockup']`). cli.js calls them by emitting `control_request { subtype: 'mcp_message', server_name, message }`, and we route the JSON-RPC through `@modelcontextprotocol/sdk`.

---

## 10.2 `--mcp-config` JSON schema

Written via `--mcp-config <json>` flag when any non-SDK server is configured. Shape:

```json
{
  "mcpServers": {
    "<name>": { "type": "stdio"|"http"|"sse", ... },
    "<name2>": { ... }
  }
}
```

Emitted by `args.ts::buildArgs()` after filtering SDK servers out via `splitMcpServers()`.

**`--strict-mcp-config`** flag: when set, cli.js will fail fast on any MCP server startup error (stdio spawn failure, HTTP auth error) instead of silently disabling the server. Passed through from `options.strictMcpConfig`.

---

## 10.3 SDK server wire protocol (`mcp_message` round-trip)

Every time cli.js needs to interact with an SDK MCP server, it sends a `control_request`:

```json
{
  "type": "control_request",
  "request_id": "<id>",
  "request": {
    "subtype": "mcp_message",
    "server_name": "claude-ui",
    "message": {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "tools/list",
      "params": {}
    }
  }
}
```

We dispatch to `McpHost.dispatch(server_name, message)`, which feeds the JSON-RPC message through `PairedTransport` into the `McpServer` from `@modelcontextprotocol/sdk`. The server's response is correlated by JSON-RPC `id` and returned.

We MUST wrap the response:

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<same id>",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "id": 1,
        "result": { "tools": [...] }
      }
    }
  }
}
```

The `mcp_response` wrapper is non-negotiable. cli.js's handler unwraps it and passes the inner JSON-RPC message to its MCP client layer.

### Notifications (no JSON-RPC id)

For notifications (JSON-RPC without `id`), the MCP server has no response to send. To keep cli.js's channel happy, we synthesize a dummy `{jsonrpc: '2.0', result: {}, id: 0}` and wrap as above. cli.js sees a well-formed reply and moves on.

---

## 10.4 JSON-RPC methods cli.js calls on SDK servers

At least (may grow with upstream MCP protocol additions):

- `initialize` — MCP handshake (called once per server lifecycle)
- `notifications/initialized` — handshake complete
- `tools/list` — fetch tool catalog
- `tools/call` — invoke a tool
- `prompts/list` / `prompts/get` — if server advertises prompts capability
- `resources/list` / `resources/read` — if server advertises resources capability
- `notifications/*` — server-to-client notifications (tool list changed, resource updated)

Our SDK servers expose only tools currently (`capabilities: { tools: {} }` in `create-sdk-mcp.ts`).

---

## 10.5 Server lifecycle

### Construction (cheap)

```ts
const host = new McpHost(sdkServers)
```

Creates one `PairedTransport` per server, maps names to `{ server, transport }`. No MCP handshake yet.

### Lazy connection

The first `dispatch()` call calls `ensureStarted()`:

```ts
ensureStarted(): Promise<void> {
  if (this.startPromise) return this.startPromise
  const promises: Promise<void>[] = []
  for (const { server, transport } of this.servers.values()) {
    if (server.instance) promises.push(server.instance.connect(transport))
  }
  this.startPromise = Promise.all(promises).then(() => undefined)
  return this.startPromise
}
```

**Critical:** the guard is a shared Promise, not a boolean flag. Two concurrent `dispatch()` calls might otherwise race — the second call would see `started=true` before the first's `connect()` resolved, and its `transport.inject()` would fire before `transport.onmessage` was wired by the MCP SDK.

### Dispatch loop

```
cli.js                    us                       McpServer (MCP SDK)
  │                       │                             │
  │ ctrl_req mcp_message  │                             │
  │──────────────────────>│                             │
  │                       │ host.dispatch(name, msg)    │
  │                       │ ──ensureStarted()           │
  │                       │ ──transport.inject(msg)     │
  │                       │ ──transport.onmessage(msg)──>│
  │                       │                             │ process
  │                       │                             │
  │                       │ <──transport.send(resp)─────│
  │                       │ (pending[id].resolve(resp)) │
  │                       │                             │
  │ ctrl_resp mcp_response│                             │
  │<──────────────────────│                             │
```

### `PairedTransport` internals

- `start()` — no-op. Transport is driven by `inject()`, not event loop.
- `send(message)` — server → us. Matches `id`, resolves the pending Promise.
- `close()` — calls `onclose?.()`. Never called in practice (we hold the host for the query lifetime).
- `inject(message)` — us → server. For requests (have `id`), stores resolver in `pending` map and calls `onmessage`. For notifications, calls `onmessage` and resolves with `null`.

Each server has its own `pending` map keyed by JSON-RPC `id`. No cross-server collisions.

### Unknown server name

If cli.js sends `mcp_message` for a server we don't host:

```json
{
  "mcp_response": {
    "jsonrpc": "2.0",
    "id": <echoed>,
    "error": { "code": -32601, "message": "Unknown MCP server: <name>" }
  }
}
```

---

## 10.6 Registering SDK servers

Use `createSdkMcpServer()` and `tool()` from `src/main/sdk`:

```ts
import { createSdkMcpServer, tool } from 'src/main/sdk'
import { z } from 'zod'

const mermaidServer = createSdkMcpServer({
  name: 'claude-ui',
  version: '1.0.0',
  tools: [
    tool(
      'render_mermaid',
      'Render a Mermaid diagram',
      {
        source: z.string().describe('Mermaid source'),
        title: z.string().optional()
      },
      async (input) => {
        return {
          content: [{ type: 'text', text: `Rendered: ${input.source}` }]
        }
      }
    )
  ]
})
```

Pass via `mcpServers` on `query()`:

```ts
query({
  prompt: '...',
  options: {
    mcpServers: { 'claude-ui': mermaidServer }
  }
})
```

`args.ts::splitMcpServers()` separates SDK servers (kept local) from CLI servers (written to `--mcp-config`). The initialize payload's `sdkMcpServers` field is an array of **name strings**, NOT descriptor objects — this is non-obvious and critical. cli.js uses the names to route tool calls back to us via `mcp_message`.

---

## 10.7 Tool call flow

```
1. Model decides to call `mcp__claude-ui__render_mermaid`.
2. cli.js sees the tool_use block, parses `server_name=claude-ui`, `tool_name=render_mermaid`.
3. cli.js sends us `control_request { subtype: 'mcp_message', server_name: 'claude-ui',
   message: { jsonrpc: '2.0', id: N, method: 'tools/call',
              params: { name: 'render_mermaid', arguments: {...} } } }`.
4. We route to McpHost.dispatch() → McpServer.tools.call().
5. Our handler runs (`async (input) => {...}`) and returns `{ content: [...] }`.
6. We wrap + return: `{ mcp_response: { jsonrpc, id: N, result: { content, ... } } }`.
7. cli.js receives the result, emits a synthetic `{type:'user', message:{content:[{type:'tool_result', ...}]}}`
   stream-json line so the consumer sees the tool result.
8. Next turn feeds the tool_result back to the model.
```

---

## 10.8 `--permission-prompt-tool` variants

Separate from SDK servers but related. Two modes:

### Mode A: `--permission-prompt-tool stdio`

Set automatically when `options.canUseTool` callback is provided. cli.js sends permission prompts as `control_request { subtype: 'can_use_tool', ... }` and we respond via the control channel.

### Mode B: `--permission-prompt-tool <mcp_tool_name>`

Set via `options.permissionPromptToolName = 'mcp__foo__check'`. cli.js invokes the named MCP tool (on any configured MCP server, including our SDK servers) to get permission decisions. Legacy — see `src/main/sdk/args.ts` validation that the two modes are mutually exclusive (throws if both set).

---

## 10.9 Runtime MCP management

Control subtypes for managing MCP servers after session start:

| Subtype                  | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `mcp_status`             | List all servers + status (connected/disabled/error)                                     |
| `mcp_toggle`             | Enable/disable a server (propagates to model's tool list — see `patch/mcp-tool-refresh`) |
| `mcp_reconnect`          | Reconnect a server (e.g., after env/config change)                                       |
| `mcp_set_servers`        | Replace the entire server config at runtime                                              |
| `mcp_authenticate`       | Start an MCP OAuth flow (long-lived)                                                     |
| `mcp_clear_auth`         | Clear stored OAuth tokens for a server                                                   |
| `mcp_oauth_callback_url` | Submit an OAuth callback URL back to cli.js                                              |
| `channel_enable`         | Enable a specific channel/capability on a server                                         |

See `07-control-outbound.md` for full details on each.

---

## 10.10 Gotchas

- **`initialize` payload must use name strings for `sdkMcpServers`**, not descriptor objects. Tested: passing objects silently disables them.
- **MCP server `connect()` is side-effectful**: it walks the server's registered tools and wires up handlers. Hence the lazy start — defer until first `dispatch()`.
- **The MCP SDK sends "notification/initialized" automatically** during handshake. Our transport's `send()` treats it like any notification (drop on floor) — cli.js doesn't need to see notifications going to our server.
- **No progress notifications are forwarded upward to consumers.** MCP `notifications/progress` messages land in `transport.onmessage` inside the MCP SDK but are never exposed on our stream. If a consumer needs them, extend `PairedTransport.send()` to pass unsolicited messages back through the control channel (not implemented).
- **Every mcp_message must be answered** — cli.js awaits the response. A dropped response stalls the model's tool call.
