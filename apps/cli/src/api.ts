// Cliente GraphQL mínimo sobre fetch. El CLI no toca la DB: solo habla con la API.
import { withoutWorkspaceFields } from "@prime-board/graphql-client";
import type { CliConfig } from "./config.ts";
import { ApiError } from "./errors.ts";

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

async function supportsWorkspaceContract(config: CliConfig): Promise<boolean> {
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

export async function gqlRequest(
  config: CliConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const supported = await supportsWorkspaceContract(config);
  const requestQuery = supported ? query : withoutWorkspaceFields(query);
  const workspaceHeader = supported ? config.workspaceId : undefined;
  let response: Response;
  try {
    response = await fetch(`${config.url.replace(/\/$/, "")}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        ...(workspaceHeader ? { "X-Workspace-ID": workspaceHeader } : {}),
      },
      body: JSON.stringify({ query: requestQuery, variables }),
    });
  } catch (error) {
    throw new ApiError(`Cannot reach prime-board at ${config.url}: ${error}`);
  }
  const payload = (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new ApiError(first.message, first.extensions?.code);
  }
  return payload.data ?? {};
}
