import { gql, invalidateWorkspaceContext } from "./api.ts";
import { credentialNamespace } from "./ui-context.ts";

export interface AccessibleWorkspace {
  id: string;
  name: string;
  urlKey: string;
}

export interface WorkspaceContract {
  supported: boolean;
}

const CONTRACT_QUERY = `query WorkspaceContract {
  __schema { queryType { fields { name } } }
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
  return key ? `pb.workspace.selection.${credentialNamespace(key)}` : null;
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

export async function getWorkspaceContract(): Promise<WorkspaceContract> {
  try {
    const result = await gql<{
      __schema?: { queryType?: { fields?: Array<{ name: string }> } };
    }>(CONTRACT_QUERY, {}, { workspaceHeader: false });
    const fields = result.__schema?.queryType?.fields ?? [];
    return { supported: fields.some((field) => field.name === "workspaces") };
  } catch {
    // Introspection is optional for legacy/single-Workspace servers.
    return { supported: false };
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
