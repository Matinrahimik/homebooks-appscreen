import { callTool, TOOLS, toolErrorStatus, type ToolSuccess } from "./tools.ts";
import type { Services } from "./types.ts";

const SERVER_INFO = { name: "homebooks-appscreen", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> | unknown[];
}

export interface McpResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown): unknown {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(payload: ToolSuccess): unknown {
  const content: Record<string, unknown>[] = [
    { type: "text", text: JSON.stringify(payload.data, null, 2) },
  ];
  for (const image of payload.images || []) {
    content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
  }
  return { content, isError: false };
}

export async function handleMcpRpc(services: Services, message: unknown): Promise<McpResponse> {
  if (Array.isArray(message)) {
    if (message.length === 0) {
      return { status: 400, body: rpcError(null, -32600, "Empty batch.") };
    }
    const responses = [];
    for (const item of message) {
      const one = await handleMcpRpc(services, item);
      if (one.status !== 202) responses.push(one.body);
    }
    if (responses.length === 0) return { status: 202, body: null };
    return { status: 200, body: responses };
  }
  if (!message || typeof message !== "object") {
    return { status: 400, body: rpcError(null, -32600, "Invalid JSON-RPC message.") };
  }
  const rpc = message as JsonRpc;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return { status: 400, body: rpcError(rpc.id, -32600, "Invalid JSON-RPC message.") };
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(rpc, "id");
  const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params) ? rpc.params : {};

  try {
    if (rpc.method === "initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2025-03-26";
      return {
        status: 200,
        body: rpcResult(rpc.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
      return { status: 202, body: null };
    }
    if (rpc.method === "ping") {
      return { status: isNotification ? 202 : 200, body: isNotification ? null : rpcResult(rpc.id, {}) };
    }
    if (rpc.method === "tools/list") {
      return {
        status: 200,
        body: rpcResult(rpc.id, {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }),
      };
    }
    if (rpc.method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const toolArgs =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        return {
          status: 200,
          body: rpcResult(rpc.id, {
            content: [{ type: "text", text: `Unknown tool "${name}".` }],
            isError: true,
          }),
        };
      }
      try {
        const result = await callTool(services, name, toolArgs);
        return { status: 200, body: rpcResult(rpc.id, toolResult(result)) };
      } catch (error) {
        const { message } = toolErrorStatus(error);
        return {
          status: 200,
          body: rpcResult(rpc.id, {
            content: [{ type: "text", text: message }],
            isError: true,
          }),
        };
      }
    }
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return { status: 200, body: rpcError(rpc.id, -32603, message) };
  }
}

export function mcpHttpBody(accept: string | null, payload: McpResponse): { status: number; contentType: string; body: string | null } {
  if (payload.status === 202) return { status: 202, contentType: "application/json", body: null };
  const header = accept || "";
  const json = JSON.stringify(payload.body);
  const sseOnly = header.includes("text/event-stream") && !header.includes("application/json") && !header.includes("*/*");
  if (sseOnly) {
    return {
      status: payload.status,
      contentType: "text/event-stream",
      body: `event: message\ndata: ${json}\n\n`,
    };
  }
  return { status: payload.status, contentType: "application/json", body: json };
}
