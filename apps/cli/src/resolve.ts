// Resolución de nombres amigables a IDs (teams por key, estados por nombre o tipo,
// labels por nombre, "me" como viewer).
import { gqlRequest } from "./api.ts";
import type { CliConfig } from "./config.ts";
import { ApiError, UsageError } from "./errors.ts";

export async function resolveTeam(config: CliConfig, key: string): Promise<any> {
  const data = await gqlRequest(config, `query($key: String) {
    team(key: $key) { id key name states { id name type } }
  }`, { key });
  if (!data.team) throw new ApiError(`Team not found: ${key}`, "NOT_FOUND");
  return data.team;
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

/** Devuelve { stateId } si matchea un nombre, o { stateType } si es un tipo semántico. */
export function resolveState(
  states: Array<{ id: string; name: string; type: string }> | null,
  value: string,
): { stateId?: string; stateType?: string } {
  const lower = value.toLowerCase();
  const byName = states?.find((state) => state.name.toLowerCase() === lower);
  if (byName) return { stateId: byName.id };
  if (STATE_TYPES.includes(lower)) return { stateType: lower.toUpperCase() };
  throw new UsageError(
    `Unknown state: ${value} (use a state name${states ? ` like ${states.map((s) => s.name).join("|")}` : ""} or a type ${STATE_TYPES.join("|")})`,
  );
}

export async function resolveViewerId(config: CliConfig): Promise<string> {
  const data = await gqlRequest(config, "{ viewer { id } }");
  return data.viewer.id;
}

export async function resolveAssignee(config: CliConfig, value: string): Promise<string | null> {
  if (value === "none") return null;
  if (value === "me") return resolveViewerId(config);
  return value;
}

export async function resolveLabels(
  config: CliConfig,
  teamId: string,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const data = await gqlRequest(config, `query($team: ID) {
    labels(team: $team) { id name }
  }`, { team: teamId });
  return names.map((name) => {
    const label = data.labels.find((l: any) => l.name.toLowerCase() === name.toLowerCase());
    if (!label) throw new ApiError(`Label not found: ${name}`, "NOT_FOUND");
    return label.id as string;
  });
}

export async function resolveIssue(config: CliConfig, ref: string): Promise<any> {
  const data = await gqlRequest(config, `query($id: ID!) {
    issue(id: $id) { id identifier team { id key states { id name type } } }
  }`, { id: ref });
  if (!data.issue) throw new ApiError(`Issue not found: ${ref}`, "NOT_FOUND");
  return data.issue;
}

export async function readBody(value: string | undefined): Promise<string> {
  if (value === "-" || value === undefined) {
    const stdin = await Bun.stdin.text();
    if (!stdin.trim()) throw new UsageError("Empty body from stdin");
    return stdin;
  }
  return value;
}
