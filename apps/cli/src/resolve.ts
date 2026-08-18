// Resolución de nombres amigables a IDs (teams por key, estados por nombre o tipo,
// labels por nombre, "me" como viewer).
import { gqlRequest } from "./api.ts";
import type { CliConfig } from "./config.ts";
import { ApiError, UsageError } from "./errors.ts";

export async function resolveTeam(
  config: CliConfig,
  ref: string,
  includeArchived = false,
): Promise<any> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const data = await gqlRequest(
    config,
    byId
      ? `query($id: ID!, $includeArchived: Boolean) { team(id: $id, includeArchived: $includeArchived) { id key name states { id name type } archivedAt } }`
      : `query($key: String!, $includeArchived: Boolean) { team(key: $key, includeArchived: $includeArchived) { id key name states { id name type } archivedAt } }`,
    byId ? { id: ref, includeArchived } : { key: ref, includeArchived },
  );
  if (!data.team) throw new ApiError(`Team not found: ${ref}`, "NOT_FOUND");
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

export async function resolveActor(config: CliConfig, value: string): Promise<string> {
  if (value === "me") return resolveViewerId(config);
  const data = await gqlRequest(config, `{ actors { id name } }`);
  const actor = data.actors.find(
    (candidate: { id: string; name: string }) =>
      candidate.id === value || candidate.name.toLowerCase() === value.toLowerCase(),
  );
  if (!actor) throw new ApiError(`Actor not found: ${value}`, "NOT_FOUND");
  return actor.id;
}

export async function resolveAssignee(config: CliConfig, value: string): Promise<string | null> {
  if (value === "none") return null;
  if (value === "me") return resolveViewerId(config);
  return value;
}

export async function resolveProject(config: CliConfig, ref: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  const data = await gqlRequest(config, `{ projects(includeArchived: true) { id name } }`);
  const matches = data.projects.filter(
    (candidate: any) => candidate.name.toLowerCase() === ref.toLowerCase(),
  );
  if (!matches.length) throw new ApiError(`Project not found: ${ref}`, "NOT_FOUND");
  if (matches.length > 1) {
    throw new ApiError(`Project name is ambiguous: ${ref}; use its ID`, "VALIDATION_FAILED");
  }
  return matches[0].id;
}

export async function resolveMilestone(
  config: CliConfig,
  ref: string,
  projectRef?: string,
): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  const data = await gqlRequest(
    config,
    `{ projects(includeArchived: true) { id name milestones { id name } } }`,
  );
  let projects = data.projects;
  if (projectRef) {
    const projectMatches = /^[0-9a-f-]{36}$/i.test(projectRef)
      ? projects.filter((project: any) => project.id === projectRef)
      : projects.filter((project: any) => project.name.toLowerCase() === projectRef.toLowerCase());
    if (!projectMatches.length) throw new ApiError(`Project not found: ${projectRef}`, "NOT_FOUND");
    if (projectMatches.length > 1) {
      throw new ApiError(
        `Project name is ambiguous: ${projectRef}; use its ID`,
        "VALIDATION_FAILED",
      );
    }
    projects = projectMatches;
  }
  const [projectName, milestoneName] = ref.includes("/") ? ref.split(/\/(.*)/s) : [undefined, ref];
  if (projectName) {
    const projectMatches = projects.filter(
      (project: any) => project.name.toLowerCase() === projectName.toLowerCase(),
    );
    if (!projectMatches.length)
      throw new ApiError(`Project not found: ${projectName}`, "NOT_FOUND");
    if (projectMatches.length > 1) {
      throw new ApiError(
        `Project name is ambiguous: ${projectName}; use its ID`,
        "VALIDATION_FAILED",
      );
    }
    projects = projectMatches;
  }
  const milestones = projects.flatMap((project: any) =>
    project.milestones.filter(
      (milestone: any) => milestone.name.toLowerCase() === milestoneName.toLowerCase(),
    ),
  );
  if (!milestones.length) throw new ApiError(`Milestone not found: ${ref}`, "NOT_FOUND");
  if (milestones.length > 1) {
    throw new ApiError(
      `Milestone name is ambiguous: ${ref}; use Project/Milestone`,
      "VALIDATION_FAILED",
    );
  }
  return milestones[0].id;
}

export async function resolveCycle(
  config: CliConfig,
  ref: string,
  teamId?: string,
): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  if (!teamId) throw new UsageError(`--team is required to resolve cycle by name: ${ref}`);
  const data = await gqlRequest(
    config,
    `query($teamId: ID!) { cycles(teamId: $teamId) { id number name } }`,
    { teamId },
  );
  const cycle = data.cycles.find(
    (candidate: any) =>
      candidate.name.toLowerCase() === ref.toLowerCase() || String(candidate.number) === ref,
  );
  if (!cycle) throw new ApiError(`Cycle not found: ${ref}`, "NOT_FOUND");
  return cycle.id;
}

export async function resolveLabels(
  config: CliConfig,
  teamId: string,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const data = await gqlRequest(
    config,
    `query($team: ID) {
      labels(team: $team) { id name teamId }
      team(id: $team) { key name }
    }`,
    { team: teamId },
  );
  return names.map((name) => {
    if (/^[0-9a-f-]{36}$/i.test(name)) return name;
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
        throw new ApiError(`Unknown label scope: ${qualifier}`, "VALIDATION_FAILED");
      }
      candidates = candidates.filter((label: any) =>
        isWorkspace ? label.teamId === null : label.teamId === teamId,
      );
    } else {
      const teamLabels = candidates.filter((label: any) => label.teamId === teamId);
      candidates = teamLabels.length
        ? teamLabels
        : candidates.filter((label: any) => !label.teamId);
    }
    if (!candidates.length) throw new ApiError(`Label not found: ${name}`, "NOT_FOUND");
    if (candidates.length > 1) {
      throw new ApiError(`Label name is ambiguous: ${name}; use its scope`, "VALIDATION_FAILED");
    }
    return candidates[0].id as string;
  });
}

export async function resolveIssue(config: CliConfig, ref: string): Promise<any> {
  const data = await gqlRequest(
    config,
    `query($id: ID!) {
    issue(id: $id) {
      id identifier project { id name }
      team { id key states { id name type } }
    }
  }`,
    { id: ref },
  );
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
