// Cliente GraphQL del MCP server: una sesión stdio fija a un contexto efectivo.
import { withoutWorkspaceFields } from "@prime-board/graphql-client";
const WORKSPACE_CONTRACT_QUERY = `query WorkspaceContract {
  __schema {
    queryType { fields { name } }
    types { name fields { name } }
  }
}`;

const WORKSPACE_SCOPED_TYPES = [
  "Actor",
  "ApiKey",
  "ActorInvitation",
  "Team",
  "Label",
  "Webhook",
] as const;

type WorkspaceContractPayload = {
  __schema?: {
    queryType?: { fields?: Array<{ name?: string | null }> | null } | null;
    types?: Array<{
      name?: string | null;
      fields?: Array<{ name?: string | null }> | null;
    }> | null;
  } | null;
};

function hasWorkspaceContract(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || !("__schema" in payload)) return null;
  const schema = (payload as WorkspaceContractPayload).__schema;
  if (!schema) return null;
  const queryFields = schema.queryType?.fields ?? [];
  const types = new Map((schema.types ?? []).map((type) => [type.name, type]));
  const hasWorkspaceFields = WORKSPACE_SCOPED_TYPES.every((typeName) =>
    types.get(typeName)?.fields?.some((field) => field.name === "workspaceId"),
  );
  return queryFields.some((field) => field.name === "workspaces") && hasWorkspaceFields;
}

type ContractCacheKey = string;

function contractCacheKey(url: string, apiKey: string): ContractCacheKey {
  return JSON.stringify([url, apiKey]);
}

const detectedContracts = new Map<ContractCacheKey, boolean>();
const detectingContracts = new Map<ContractCacheKey, Promise<boolean>>();

async function supportsWorkspaceContract(config: McpConfig): Promise<boolean> {
  const url = config.url.replace(/\/$/, "");
  const key = contractCacheKey(url, config.apiKey);
  const cached = detectedContracts.get(key);
  if (cached !== undefined) return cached;
  const inFlight = detectingContracts.get(key);
  if (inFlight) return inFlight;

  const detection = (async () => {
    try {
      const response = await fetch(`${url}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "x-prime-board-mcp-auth": "required",
        },
        body: JSON.stringify({ query: WORKSPACE_CONTRACT_QUERY, variables: {} }),
      });
      if (!response.ok) return true;
      const payload = (await response.json()) as { data?: unknown; errors?: unknown[] };
      if (payload.errors?.length) return true;
      const supported = hasWorkspaceContract(payload.data);
      return supported ?? true;
    } catch {
      // El request normal informa los errores de conectividad. Conserva los campos
      // modernos cuando el servidor no expone introspección.
      return true;
    }
  })();
  detectingContracts.set(key, detection);
  try {
    const supported = await detection;
    detectedContracts.set(key, supported);
    return supported;
  } finally {
    if (detectingContracts.get(key) === detection) detectingContracts.delete(key);
  }
}

export interface EffectiveWorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  workspaceUrlKey: string;
  actorId: string;
  actorName: string;
  actorType: string;
}

export interface McpConfig {
  url: string;
  apiKey: string;
  /** Workspace efectivo seleccionado para un contrato moderno. */
  workspaceId?: string;
}

export class McpApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "McpApiError";
  }
}

/** Credencial y endpoint quedan congelados al crear la sesión MCP. */
export interface McpSession extends McpConfig {
  readonly context: EffectiveWorkspaceContext;
}

export function safeEndpointUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    // Las cadenas inválidas pueden incluir credenciales en una ruta aparente. No
    // intentes una redacción parcial; el log de inicio debe quedar sin secretos.
    return "[redacted-endpoint-url]";
  }
}

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const url = env.PRIME_BOARD_URL ?? "http://localhost:3333";
  const apiKey = env.PRIME_BOARD_API_KEY;
  if (!apiKey) {
    throw new Error("PRIME_BOARD_API_KEY is required to run the prime-board MCP server");
  }
  return { url, apiKey };
}

export async function gqlRequest(
  config: McpConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const supported = await supportsWorkspaceContract(config);
  const requestQuery = supported ? query : withoutWorkspaceFields(query);
  const workspaceHeader = supported ? config.workspaceId : undefined;
  const response = await fetch(`${config.url.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...(workspaceHeader ? { "X-Workspace-ID": workspaceHeader } : {}),
      "x-prime-board-mcp-auth": "required",
    },
    body: JSON.stringify({ query: requestQuery, variables }),
  });
  const payload = (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new McpApiError(first.extensions?.code ?? "ERROR", first.message);
  }
  return payload.data ?? {};
}

const SESSION_IDENTITY_QUERY = `{
  viewer { id name type }
  workspace { id name urlKey }
}`;

/**
 * Resuelve una sola vez la identidad devuelta por el endpoint single-workspace.
 * No recibe workspaceId de inputs ni expone una operación de selección.
 */
export async function createMcpSession(config: McpConfig): Promise<McpSession> {
  const fixedConfig = Object.freeze({ url: config.url, apiKey: config.apiKey });
  const data = await gqlRequest(fixedConfig, SESSION_IDENTITY_QUERY);
  if (!data.viewer?.id || !data.workspace?.id) {
    throw new Error("The server did not return an effective Workspace context");
  }
  const context: EffectiveWorkspaceContext = Object.freeze({
    workspaceId: data.workspace.id,
    workspaceName: data.workspace.name,
    workspaceUrlKey: data.workspace.urlKey,
    actorId: data.viewer.id,
    actorName: data.viewer.name,
    actorType: data.viewer.type,
  });
  return Object.freeze({ ...fixedConfig, workspaceId: context.workspaceId, context });
}
