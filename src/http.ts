#!/usr/bin/env node
// HTTP entry point for QuickBooks MCP server (Streamable HTTP transport)
// Long-running service for one company: QBO_CREDENTIAL_FILE names its token
// file, and this process is the only one that refreshes it. Every tool call
// refreshes and rewrites the tokens, so calls run one at a time.

import { createServer as createHttpServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { setOutputMode } from "./utils/output.js";
import { toolDefinitions, executeTool } from "./tools/index.js";

setOutputMode("http");

const PORT = Number(process.env.PORT || "8080");
const HOST = process.env.HOST || "0.0.0.0";
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";

// One call at a time, across every request this process serves
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

function createServer(): Server {
  const server = new Server(
    { name: "quickbooks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return serialized(() => executeTool(name, args as Record<string, unknown>));
  });

  return server;
}

function authorized(req: IncomingMessage): boolean {
  if (!BEARER_TOKEN) return true;
  const given = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${BEARER_TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

const httpServer = createHttpServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (path === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (path !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    return;
  }

  // Stateless: no session, so no standalone SSE stream and nothing to delete
  if (req.method !== "POST") {
    sendJson(res, 405, jsonRpcError(-32000, "Method not allowed."), { Allow: "POST" });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
    }
  }
});

// Let an in-flight call finish saving its refreshed tokens before exiting.
// utils/files.ts exits at once on these signals, so its handlers go first.
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");

function shutdown(signal: string): void {
  console.error(`${signal} received, finishing in-flight calls`);
  httpServer.close();
  void queue.finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

httpServer.listen(PORT, HOST, () => {
  console.error(`QuickBooks MCP server listening on http://${HOST}:${PORT}/mcp`);
});
