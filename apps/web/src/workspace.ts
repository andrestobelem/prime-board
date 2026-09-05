import {
  getWorkspaceContractKey,
  getWorkspaceContractSupported,
  gql,
  invalidateWorkspaceContext,
  setWorkspaceContractSupported,
} from "./api.ts";
import { credentialNamespace } from "./ui-context.ts";

export interface AccessibleWorkspace {
  id: string;
  name: string;
  urlKey: string;
}

export interface WorkspaceContract {
  supported: boolean;
}

const WORKSPACE_SCOPED_TYPES = [
  "Actor",
  "ApiKey",
  "ActorInvitation",
  "Team",
  "Label",
  "Webhook",
] as const;

type IntrospectionType = {
  name: string;
  fields?: Array<{ name: string }> | null;
};

const CONTRACT_QUERY = `query WorkspaceContract {
  __schema {
    queryType { fields { name } }
    types { name fields { name } }
  }
}`;

const WORKSPACES_QUERY = `query AccessibleWorkspaces {
  workspaces { id name urlKey }
}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function selectionKey(): string | null {
  const key = storage()?.getItem("pb.apiKey")?.trim();
  return `pb.workspace.selection.${key ? credentialNamespace(key) : "local"}`;
}

export function getSelectedWorkspaceId(): string | null {
  const key = selectionKey();
  return key ? (storage()?.getItem(key) ?? null) : null;
}

export function setSelectedWorkspaceId(workspaceId: string): void {
  const key = selectionKey();
  if (!key) return;
  storage()?.setItem(key, workspaceId);
  invalidateWorkspaceContext();
}

export function clearSelectedWorkspaceId(): void {
  const key = selectionKey();
  if (key) storage()?.removeItem(key);
}

const detectingWorkspaceContracts = new Map<string, Promise<WorkspaceContract>>();

export async function getWorkspaceContract(): Promise<WorkspaceContract> {
  const key = getWorkspaceContractKey();
  const cached = getWorkspaceContractSupported(key);
  if (cached !== null) return { supported: cached };
  const inFlight = detectingWorkspaceContracts.get(key);
  if (inFlight) return inFlight;

  const detection = (async (): Promise<WorkspaceContract> => {
    try {
      const result = await gql<{
        __schema?: {
          queryType?: { fields?: Array<{ name: string }> };
          types?: IntrospectionType[];
        };
      }>(CONTRACT_QUERY, {}, { workspaceHeader: false });
      const queryFields = result.__schema?.queryType?.fields ?? [];
      const types = new Map((result.__schema?.types ?? []).map((type) => [type.name, type]));
      const hasWorkspaceFields = WORKSPACE_SCOPED_TYPES.every((typeName) =>
        types.get(typeName)?.fields?.some((field) => field.name === "workspaceId"),
      );
      const supported =
        queryFields.some((field) => field.name === "workspaces") && hasWorkspaceFields;
      setWorkspaceContractSupported(supported, key);
      return { supported };
    } catch {
      // Introspection is optional for legacy/single-Workspace servers.
      setWorkspaceContractSupported(false, key);
      return { supported: false };
    }
  })();
  detectingWorkspaceContracts.set(key, detection);
  try {
    return await detection;
  } finally {
    if (detectingWorkspaceContracts.get(key) === detection) detectingWorkspaceContracts.delete(key);
  }
}

export async function listAccessibleWorkspaces(): Promise<AccessibleWorkspace[]> {
  const result = await gql<{ workspaces?: AccessibleWorkspace[] }>(
    WORKSPACES_QUERY,
    {},
    { workspaceHeader: false },
  );
  return result.workspaces ?? [];
}

export function selectWorkspace(
  workspaces: AccessibleWorkspace[],
  routeWorkspaceKey?: string,
): AccessibleWorkspace | null {
  if (routeWorkspaceKey) {
    return workspaces.find((workspace) => workspace.urlKey === routeWorkspaceKey) ?? null;
  }
  const selected = getSelectedWorkspaceId();
  return workspaces.find((workspace) => workspace.id === selected) ?? workspaces[0] ?? null;
}
