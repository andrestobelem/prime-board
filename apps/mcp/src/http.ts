#!/usr/bin/env bun
// MCP server por Streamable HTTP para integraciones locales.
// Cada sesión HTTP queda vinculada a la API key que la inicializó.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpApiError, createMcpSession, type McpConfig, type McpSession } from "./api.ts";
import { createServer } from "./server.ts";

export interface McpHttpConfig {
  /** Origen de la API GraphQL. */
  url: string;
  /** Dirección local de escucha HTTP. Por defecto 127.0.0.1. */
  hostname: string;
  /** Puerto HTTP local. Por defecto 3334. */
  port: number;
  /** Ruta del endpoint MCP. Por defecto /mcp. */
  path: string;
}

export interface McpHttpHandlerOptions {
  /** Seam de inyección de dependencias para tests de protocolo/auth. */
  createSession?: typeof createMcpSession;
  /** Seam de inyección de dependencias para tests de protocolo/auth. */
  createServer?: typeof createServer;
}

type McpTransport = WebStandardStreamableHTTPServerTransport;

type HttpSession = {
  apiKey: string;
  server: McpServer;
  transport: McpTransport;
};

const JSON_HEADERS = { "content-type": "application/json" };

function jsonError(status: number, message: string, code = -32000): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: JSON_HEADERS,
  });
}

function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message } }), {
    status: 401,
    headers: {
      ...JSON_HEADERS,
      // Es el challenge esperado por clientes MCP HTTP cuando falla la auth.
      "www-authenticate": 'Bearer realm="prime-board-mcp"',
    },
  });
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function isAuthError(error: unknown): error is McpApiError {
  return (
    error instanceof McpApiError &&
    ["UNAUTHORIZED", "FORBIDDEN", "AUTHENTICATION_FAILED"].includes(error.code)
  );
}

/**
 * Crea el seam público Web Standard usado por Bun.serve y por los tests.
 *
 * El transporte del SDK MCP se ocupa de validar el protocolo y encuadrar las
 * respuestas SSE/JSON. Este adaptador solo enruta requests, autentica su API key
 * y reutiliza los handlers de tools existentes de `createServer` por sesión MCP.
 */
export function createMcpHttpHandler(
  config: Pick<McpConfig, "url"> & Partial<Pick<McpHttpConfig, "path">>,
  options: McpHttpHandlerOptions = {},
): { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> } {
  const endpoint = (config.path ?? "/mcp").replace(/\/+$/, "") || "/";
  const sessions = new Map<string, HttpSession>();
  const createSession = options.createSession ?? createMcpSession;
  const makeServer = options.createServer ?? createServer;

  async function authenticatedSession(apiKey: string): Promise<McpSession> {
    try {
      return await createSession({ url: config.url, apiKey });
    } catch (error) {
      if (isAuthError(error)) throw error;
      throw new Error(
        `MCP session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function createTransport(apiKey: string): Promise<HttpSession> {
    const session = await authenticatedSession(apiKey);
    let httpSession!: HttpSession;
    const transport = new WebStandardStreamableHTTPServerTransport({
      // El modo stateful permite conservar el contexto autenticado entre requests
      // tools/call y soportar el cierre explícito de sesión mediante DELETE.
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, httpSession);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    const server = makeServer(session);
    httpSession = { apiKey, server, transport };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
      // McpServer.close() es idempotente después de cerrar el transporte.
      void server.close().catch(() => undefined);
    };
    await server.connect(transport);
    return httpSession;
  }

  async function closeUnregistered(session: HttpSession): Promise<void> {
    if (session.transport.sessionId === undefined) {
      await session.server.close();
    }
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== endpoint && url.pathname !== `${endpoint}/`) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    const apiKey = bearerToken(request);
    if (!apiKey) return unauthorized("Bearer API key is required");

    const sessionId = request.headers.get("mcp-session-id");
    let session: HttpSession | undefined;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session) return jsonError(404, "Session not found", -32001);
      // El ID de sesión no es una credencial. Exigimos la misma API key en cada
      // request para que una sesión MCP filtrada no pueda repetirse anónimamente.
      if (session.apiKey !== apiKey) return unauthorized("API key does not match the MCP session");
      try {
        // Revalidate on every request so revocation/expiry takes effect before
        // notifications, tools/list, or tools/call reach the MCP transport.
        await authenticatedSession(apiKey);
      } catch (error) {
        if (isAuthError(error)) return unauthorized("Invalid or inactive API key");
        console.error("Failed to revalidate MCP HTTP session:", error);
        return jsonError(502, "Unable to revalidate MCP session", -32603);
      }
    } else {
      try {
        session = await createTransport(apiKey);
      } catch (error) {
        if (isAuthError(error)) return unauthorized("Invalid API key");
        console.error("Failed to initialize MCP HTTP session:", error);
        return jsonError(502, "Unable to initialize MCP session", -32603);
      }
    }

    try {
      const response = await session.transport.handleRequest(request);
      await closeUnregistered(session);
      return response;
    } catch (error) {
      await closeUnregistered(session).catch(() => undefined);
      console.error("Failed to handle MCP HTTP request:", error);
      return jsonError(500, "Internal server error", -32603);
    }
  }

  return {
    fetch,
    async close() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.all(active.map(async ({ server }) => server.close()));
    },
  };
}

/** Carga la configuración HTTP sin exigir una API key global al proceso. */
export function loadMcpHttpConfig(
  env: Record<string, string | undefined> = process.env,
): McpHttpConfig {
  const portValue = env.PRIME_BOARD_MCP_PORT ?? "3334";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PRIME_BOARD_MCP_PORT must be an integer between 0 and 65535: ${portValue}`);
  }
  const path = env.PRIME_BOARD_MCP_PATH ?? "/mcp";
  if (!path.startsWith("/")) throw new Error("PRIME_BOARD_MCP_PATH must start with `/`");
  const hostname = env.PRIME_BOARD_MCP_HOST ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") {
    throw new Error("PRIME_BOARD_MCP_HOST must be 127.0.0.1 for a local MCP server");
  }
  return {
    url: env.PRIME_BOARD_URL ?? "http://localhost:3333",
    hostname,
    port,
    path: path === "/" ? "/" : path.replace(/\/$/, ""),
  };
}

if (import.meta.main) {
  const config = loadMcpHttpConfig();
  const handler = createMcpHttpHandler(config);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: handler.fetch,
  });
  console.error(
    `prime-board MCP Streamable HTTP server listening on ${new URL(config.path, server.url).href}`,
  );

  const shutdown = async () => {
    server.stop(true);
    await handler.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}
