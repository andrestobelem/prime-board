// Resolución de referencias amigables (keys, nombres, "me") a IDs.
import { gqlRequest, type McpConfig } from "./api.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveTeam(config: McpConfig, ref: string): Promise<any> {
  const byId = UUID_RE.test(ref);
  const data = await gqlRequest(config, `query($id: ID, $key: String) {
    team(id: $id, key: $key) { id key name states { id name type color position } }
  }`, byId ? { id: ref } : { key: ref });
  if (!data.team) throw new Error(`NOT_FOUND: Team not found: ${ref}`);
  return data.team;
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

export function resolveStateFilter(
  states: Array<{ id: string; name: string; type: string }> | null,
  value: string,
): { state?: { eq: string }; stateType?: { eq: string } } {
  const lower = value.toLowerCase();
  const byName = states?.find((state) => state.name.toLowerCase() === lower);
  if (byName) return { state: { eq: byName.id } };
  if (STATE_TYPES.includes(lower)) return { stateType: { eq: lower.toUpperCase() } };
  if (UUID_RE.test(value)) return { state: { eq: value } };
  throw new Error(`NOT_FOUND: Unknown state: ${value}`);
}

export async function resolveActor(config: McpConfig, ref: string): Promise<string> {
  if (ref === "me") {
    const data = await gqlRequest(config, "{ viewer { id } }");
    return data.viewer.id;
  }
  if (UUID_RE.test(ref)) return ref;
  const data = await gqlRequest(config, "{ actors { id name } }");
  const actor = data.actors.find((a: any) => a.name.toLowerCase() === ref.toLowerCase());
  if (!actor) throw new Error(`NOT_FOUND: Actor not found: ${ref}`);
  return actor.id;
}

export async function resolveLabelIds(
  config: McpConfig,
  teamId: string,
  names: string[],
): Promise<string[]> {
  const data = await gqlRequest(config, `query($team: ID) { labels(team: $team) { id name } }`, {
    team: teamId,
  });
  return names.map((name) => {
    const label = data.labels.find((l: any) => l.name.toLowerCase() === name.toLowerCase());
    if (!label) throw new Error(`NOT_FOUND: Label not found: ${name}`);
    return label.id as string;
  });
}

const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];

export function resolvePriority(value: number | string): number {
  if (typeof value === "number") return value;
  const index = PRIORITY_NAMES.indexOf(value.toLowerCase());
  if (index === -1) throw new Error(`VALIDATION_FAILED: Invalid priority: ${value}`);
  return index;
}
