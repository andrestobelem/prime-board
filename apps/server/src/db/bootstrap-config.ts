import {
  DEFAULT_TEAM_KEY,
  DEFAULT_TEAM_NAME,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_URL_KEY,
} from "./defaults.ts";

export interface BootstrapIdentity {
  workspaceName: string;
  workspaceUrlKey: string;
  teamName: string;
  teamKey: string;
}

export type BootstrapIdentityInput = Partial<Record<keyof BootstrapIdentity, string | undefined>>;

export function normalizeWorkspaceName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Workspace name cannot be empty");
  return name;
}

export function normalizeWorkspaceUrlKey(value: string): string {
  const urlKey = value.trim();
  if (!urlKey) throw new Error("Workspace url key cannot be empty");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(urlKey)) {
    throw new Error(
      "Workspace URL key must contain only lowercase letters, numbers, and single hyphens",
    );
  }
  return urlKey;
}

export function normalizeTeamName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Team name cannot be empty");
  return name;
}

export function normalizeTeamKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(key)) {
    throw new Error("Team key must be 1-8 alphanumeric characters starting with a letter");
  }
  return key;
}

export function resolveBootstrapIdentity(input: BootstrapIdentityInput): BootstrapIdentity {
  return {
    workspaceName: normalizeWorkspaceName(input.workspaceName ?? DEFAULT_WORKSPACE_NAME),
    workspaceUrlKey: normalizeWorkspaceUrlKey(input.workspaceUrlKey ?? DEFAULT_WORKSPACE_URL_KEY),
    teamName: normalizeTeamName(input.teamName ?? DEFAULT_TEAM_NAME),
    teamKey: normalizeTeamKey(input.teamKey ?? DEFAULT_TEAM_KEY),
  };
}
