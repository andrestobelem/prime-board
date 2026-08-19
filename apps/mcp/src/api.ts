// Cliente GraphQL del MCP server: una sesión stdio fija a un contexto efectivo.
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
}

/** Credencial y endpoint quedan congelados al crear la sesión MCP. */
export interface McpSession extends McpConfig {
  readonly context: EffectiveWorkspaceContext;
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
  const response = await fetch(`${config.url.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new Error(`${first.extensions?.code ?? "ERROR"}: ${first.message}`);
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
  return Object.freeze({ ...fixedConfig, context });
}
