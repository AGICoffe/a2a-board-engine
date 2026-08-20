import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Cloudflare WorkerのエンドポイントURL
const WORKER_URL = process.env.WORKER_URL || "https://a2a-board-engine.my-agent-api.workers.dev";

const server = new Server(
  { name: "a2a-board-engine", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ツール一覧の定義
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "post_board",
        description: "Post a semantic intent board with a 24h deposit to Cloudflare Edge.",
        inputSchema: {
          type: "object",
          properties: {
            domain: { type: "string" },
            identity: { type: "string" },
            intent_space: { type: "object" },
            payment_header: { type: "string", description: "X-PAYMENT header value" }
          },
          required: ["domain", "identity", "intent_space"]
        }
      },
      {
        name: "match_board",
        description: "Perform zero-token pre-filtering match check at Cloudflare Edge.",
        inputSchema: {
          type: "object",
          properties: {
            domain: { type: "string" },
            identity: { type: "string" },
            intent_space: { type: "object" },
            similarity_threshold: { type: "number" }
          },
          required: ["domain", "identity", "intent_space"]
        }
      }
    ]
  };
});

// ツールの実行処理（Cloudflare Workerへ転送）
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "post_board") {
    const headers = { "Content-Type": "application/json" };
    if (args.payment_header) headers["X-PAYMENT"] = args.payment_header;

    const res = await fetch(`${WORKER_URL}/api/board`, {
      method: "POST",
      headers,
      body: JSON.stringify(args)
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "match_board") {
    const res = await fetch(`${WORKER_URL}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  throw new Error(`Tool not found: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
