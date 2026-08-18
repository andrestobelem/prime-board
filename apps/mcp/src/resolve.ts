// Resolución de referencias amigables (keys, nombres, "me") a IDs.
import { gqlRequest, type McpConfig } from "./api.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveTeam(
  config: McpConfig,
  ref: string,
  includeArchived = false,
): Promise<any> {
  const byId = UUID_RE.test(ref);
  const data = await gqlRequest(
    config,
    `query($id: ID, $key: String, $includeArchived: Boolean) {
    team(id: $id, key: $key, includeArchived: $includeArchived) {
      id key name archivedAt states { id name type color position }
    }
  }`,
    byId ? { id: ref, includeArchived } : { key: ref, includeArchived },
  );
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

export async function resolveProject(config: McpConfig, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const data = await gqlRequest(config, `{ projects(includeArchived: true) { id name } }`);
  const matches = data.projects.filter(
    (candidate: any) => candidate.name.toLowerCase() === ref.toLowerCase(),
  );
  if (!matches.length) throw new Error(`NOT_FOUND: Project not found: ${ref}`);
  if (matches.length > 1) {
    throw new Error(`VALIDATION_FAILED: Project name is ambiguous: ${ref}; use its ID`);
  }
  return matches[0].id;
}

export async function resolveMilestone(
  config: McpConfig,
  ref: string,
  projectRef?: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const data = await gqlRequest(
    config,
    `{ projects(includeArchived: true) { id name milestones { id name } } }`,
  );
  let projects = data.projects;
  if (projectRef) {
    const projectMatches = UUID_RE.test(projectRef)
      ? projects.filter((project: any) => project.id === projectRef)
      : projects.filter((project: any) => project.name.toLowerCase() === projectRef.toLowerCase());
    if (!projectMatches.length) throw new Error(`NOT_FOUND: Project not found: ${projectRef}`);
    if (projectMatches.length > 1) {
      throw new Error(`VALIDATION_FAILED: Project name is ambiguous: ${projectRef}; use its ID`);
    }
    projects = projectMatches;
  }
  const [projectName, milestoneName] = ref.includes("/") ? ref.split(/\/(.*)/s) : [undefined, ref];
  if (projectName) {
    const projectMatches = projects.filter(
      (project: any) => project.name.toLowerCase() === projectName.toLowerCase(),
    );
    if (!projectMatches.length) throw new Error(`NOT_FOUND: Project not found: ${projectName}`);
    if (projectMatches.length > 1) {
      throw new Error(`VALIDATION_FAILED: Project name is ambiguous: ${projectName}; use its ID`);
    }
    projects = projectMatches;
  }
  const milestones = projects.flatMap((project: any) =>
    project.milestones
      .filter((milestone: any) => milestone.name.toLowerCase() === milestoneName.toLowerCase())
      .map((milestone: any) => ({ ...milestone, projectName: project.name })),
  );
  if (!milestones.length) throw new Error(`NOT_FOUND: Milestone not found: ${ref}`);
  if (milestones.length > 1) {
    throw new Error(
      `VALIDATION_FAILED: Milestone name is ambiguous: ${ref}; use Project/Milestone`,
    );
  }
  return milestones[0].id;
}

export async function resolveCycle(
  config: McpConfig,
  ref: string,
  teamId?: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  if (!teamId) throw new Error(`VALIDATION_FAILED: team is required to resolve cycle: ${ref}`);
  const data = await gqlRequest(
    config,
    `query($teamId: ID!) { cycles(teamId: $teamId) { id number name } }`,
    {
      teamId,
    },
  );
  const cycle = data.cycles.find(
    (candidate: any) =>
      candidate.name.toLowerCase() === ref.toLowerCase() || String(candidate.number) === ref,
  );
  if (!cycle) throw new Error(`NOT_FOUND: Cycle not found: ${ref}`);
  return cycle.id;
}

export async function resolveIssueId(config: McpConfig, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const data = await gqlRequest(config, `query($id: ID!) { issue(id: $id) { id } }`, { id: ref });
  if (!data.issue) throw new Error(`NOT_FOUND: Issue not found: ${ref}`);
  return data.issue.id;
}

export async function resolveLabelIds(
  config: McpConfig,
  teamId: string | undefined,
  names: string[],
): Promise<string[]> {
  const data = await gqlRequest(
    config,
    `query($team: ID) {
      labels(team: $team) { id name teamId }
      team(id: $team) { id key name }
    }`,
    { team: teamId ?? null },
  );
  return names.map((name) => {
    if (UUID_RE.test(name)) return name;
    const slash = name.indexOf("/");
    const qualifier = slash === -1 ? null : name.slice(0, slash);
    const labelName = slash === -1 ? name : name.slice(slash + 1);
    let candidates = data.labels.filter(
      (label: any) => label.name.toLowerCase() === labelName.toLowerCase(),
    );
    if (qualifier) {
      const isWorkspace = qualifier.toLowerCase() === "workspace";
      const isTeam =
        data.team &&
        [data.team.key, data.team.name].some(
          (value: string) => value.toLowerCase() === qualifier.toLowerCase(),
        );
      if (!isWorkspace && !isTeam) {
        throw new Error(`VALIDATION_FAILED: Unknown label scope: ${qualifier}`);
      }
      candidates = candidates.filter((label: any) =>
        isWorkspace ? label.teamId === null : label.teamId === teamId,
      );
    } else if (teamId) {
      const teamLabels = candidates.filter((label: any) => label.teamId === teamId);
      candidates = teamLabels.length
        ? teamLabels
        : candidates.filter((label: any) => !label.teamId);
    }
    if (!candidates.length) throw new Error(`NOT_FOUND: Label not found: ${name}`);
    if (candidates.length > 1) {
      throw new Error(`VALIDATION_FAILED: Label name is ambiguous: ${name}; use its scope`);
    }
    return candidates[0].id as string;
  });
}

const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];

export function resolvePriority(value: number | string): number {
  if (typeof value === "number") return value;
  const index = PRIORITY_NAMES.indexOf(value.toLowerCase());
  if (index === -1) throw new Error(`VALIDATION_FAILED: Invalid priority: ${value}`);
  return index;
}
