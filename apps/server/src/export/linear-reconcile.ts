import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildLinearIssuePlan, type ExistingIssue } from "./linear-plan.ts";
import { readSourceMap, type SourceMap } from "./source-map.ts";
import {
  issueIdentifierForExport,
  type LinearExport,
  type LinearRepoExportOptions,
  type MigrationFinding,
} from "./linear-repo-export.ts";

export interface ReconciliationReport {
  sourceIssues: number;
  targetIssues: number;
  pendingCreates: string[];
  pendingUpdates: string[];
  conflicts: MigrationFinding[];
  extraTargetIssues: string[];
  sourceMap: SourceMap | null;
  sourceCounts: Record<string, number>;
  targetCounts: Record<string, number> | null;
  countMismatches: string[];
  contentMismatches: string[];
  reconciled: boolean;
}

interface TargetIssue extends ExistingIssue {
  metadata: Record<string, unknown>;
  description: string;
}

function readTargetIssues(rootDir: string): TargetIssue[] {
  const dir = join(rootDir, ".prime-board", "issues");
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => {
        const raw = readFileSync(join(dir, file), "utf8");
        const match = raw.match(/^---\n([\s\S]*?)\n---/);
        const meta = match ? (parseYaml(match[1]!) as Record<string, unknown>) : {};
        const body = raw.match(/^---[\s\S]*?---\n\n#[^\n]*\n([\s\S]*)$/)?.[1] ?? "";
        return {
          identifier: String(meta.id ?? file.replace(/\.md$/, "")),
          title: typeof meta.title === "string" ? meta.title : null,
          metadata: meta,
          description: body.trim(),
        };
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value.map(comparable).sort());
  if (value === null || value === undefined) return "null";
  return String(value);
}

function expectedIssue(
  source: LinearExport,
  issue: LinearExport["issues"][number],
  options: LinearRepoExportOptions,
): {
  identifier: string;
  fields: Record<string, unknown>;
  description: string;
} | null {
  const team = source.teams.find((candidate) => candidate.id === issue.teamId);
  if (!team) return null;
  const identifier = issueIdentifierForExport(issue, team, options);
  const actorName = (id: string | null | undefined) =>
    id ? (source.actors.find((actor) => actor.id === id)?.name ?? null) : null;
  const state = team.states.find((candidate) => candidate.id === issue.stateId);
  const project = issue.projectId
    ? source.projects.find((candidate) => candidate.id === issue.projectId)
    : null;
  const milestone =
    issue.milestoneId && project
      ? project.milestones?.find((candidate) => candidate.id === issue.milestoneId)
      : null;
  const targetBySourceId = new Map(
    source.issues.map((candidate) => {
      const candidateTeam = source.teams.find((item) => item.id === candidate.teamId);
      return [
        candidate.id,
        candidateTeam
          ? issueIdentifierForExport(candidate, candidateTeam, options)
          : candidate.identifier,
      ];
    }),
  );
  const labels = (issue.labelIds ?? [])
    .map((id) => source.labels.find((label) => label.id === id)?.name)
    .filter((name): name is string => Boolean(name))
    .sort();
  const fields: Record<string, unknown> = {
    id: identifier,
    title: issue.title,
    team: (options.teamKeyMap?.[team.id] ?? team.key).trim().toUpperCase(),
    state: state?.name ?? null,
    priority: issue.priority ?? 0,
    assignee: actorName(issue.assigneeId),
    creator: actorName(issue.creatorId),
    parent: issue.parentId ? (targetBySourceId.get(issue.parentId) ?? issue.parentId) : null,
    project: project?.name ?? null,
    milestone: milestone && project ? `${project.name}/${milestone.name}` : null,
    labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    archivedAt: issue.archivedAt ?? null,
  };
  const links = [...(issue.attachments ?? []), ...(issue.documents ?? [])].map(
    (link) => `- [${link.title ?? link.filename ?? link.url}](${link.url})`,
  );
  const description =
    links.length > 0
      ? `${issue.description ? `${issue.description}\n\n` : ""}## Linear artifacts\n${links.join("\n")}`
      : (issue.description ?? "");
  return { identifier, fields, description: description.trim() };
}

/**
 * Compara una captura con el repo actual. Los issues extra son informativos:
 * permiten verificar que el team `PRB` local no se perdió durante el corte.
 */
export function reconcileLinearExport(
  source: LinearExport,
  rootDir: string,
  options: LinearRepoExportOptions = {},
): ReconciliationReport {
  const target = readTargetIssues(rootDir);
  const targetIds = new Set(target.map((issue) => issue.identifier));
  const sourceIdentifiers = new Set<string>();
  for (const issue of source.issues) {
    const team = source.teams.find((candidate) => candidate.id === issue.teamId);
    if (team) sourceIdentifiers.add(issueIdentifierForExport(issue, team, options));
  }
  let sourceMap: SourceMap | null = null;
  const conflicts: MigrationFinding[] = [];
  try {
    sourceMap = readSourceMap(rootDir);
  } catch (error) {
    conflicts.push({ code: "INVALID_SOURCE_MAP", message: (error as Error).message });
  }
  const map = sourceMap ?? {
    version: 1 as const,
    source: "linear" as const,
    workspaceId: source.workspace.id,
    entities: {},
  };
  const reverseIssueMap = new Map<string, string>();
  for (const [sourceId, identifier] of Object.entries(map.entities.issues ?? {}))
    reverseIssueMap.set(identifier, sourceId);
  const plan = buildLinearIssuePlan(
    source.issues.map((issue) => ({
      id: issue.id,
      identifier: issueIdentifierForSource(issue, source, options),
      title: issue.title,
      description: issue.description,
    })),
    {
      existing: target.map((issue) => ({
        ...issue,
        sourceId: reverseIssueMap.get(issue.identifier) ?? null,
      })),
      sourceMap: map,
    },
  );
  conflicts.push(
    ...plan.conflicts.map((conflict) => ({
      code: conflict.code,
      message: conflict.message,
      sourceId: conflict.sourceId,
    })),
  );
  const pendingCreates = plan.items
    .filter((item) => item.action === "create")
    .map((item) => item.targetIdentifier);
  const pendingUpdates = plan.items
    .filter((item) => item.action === "update")
    .map((item) => item.targetIdentifier);
  const extraTargetIssues = [...targetIds]
    .filter((identifier) => !sourceIdentifiers.has(identifier))
    .sort();
  const contentMismatches: string[] = [];
  for (const issue of source.issues) {
    const targetIdentifier = map.entities.issues?.[issue.id];
    if (!targetIdentifier) continue;
    const targetIssue = target.find((candidate) => candidate.identifier === targetIdentifier);
    const expected = expectedIssue(source, issue, options);
    if (!targetIssue || !expected) continue;
    for (const [field, expectedValue] of Object.entries(expected.fields)) {
      if (comparable(targetIssue.metadata[field]) !== comparable(expectedValue))
        contentMismatches.push(
          `${targetIdentifier}.${field}: target=${comparable(targetIssue.metadata[field])}, source=${comparable(expectedValue)}`,
        );
    }
    if (targetIssue.description !== expected.description)
      contentMismatches.push(`${targetIdentifier}.description differs`);
  }
  const sourceCounts: Record<string, number> = {
    actors: source.actors.length,
    teams: source.teams.length,
    states: source.teams.reduce((count, team) => count + team.states.length, 0),
    labels: source.labels.length,
    projects: source.projects.length,
    milestones: source.projects.reduce(
      (count, project) => count + (project.milestones?.length ?? 0),
      0,
    ),
    issues: source.issues.length,
    comments: (source.comments ?? []).length,
    relations: (source.relations ?? []).length,
  };
  let targetCounts: Record<string, number> | null = null;
  const countMismatches: string[] = [];
  const reportPath = join(rootDir, ".prime-board", "meta", "migration-report.json");
  if (existsSync(reportPath)) {
    const report = parseYaml(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    if (report.entities && typeof report.entities === "object") {
      targetCounts = Object.fromEntries(
        Object.entries(report.entities as Record<string, unknown>).map(([key, value]) => [
          key,
          Number(value),
        ]),
      );
      for (const [key, value] of Object.entries(sourceCounts))
        if (targetCounts[key] !== value)
          countMismatches.push(`${key}: source=${value}, target=${targetCounts[key] ?? "missing"}`);
    }
  }
  return {
    sourceIssues: source.issues.length,
    targetIssues: target.length,
    pendingCreates,
    pendingUpdates,
    conflicts,
    extraTargetIssues,
    sourceMap,
    sourceCounts,
    targetCounts,
    countMismatches,
    contentMismatches,
    reconciled:
      pendingCreates.length === 0 &&
      conflicts.length === 0 &&
      countMismatches.length === 0 &&
      contentMismatches.length === 0,
  };
}

function issueIdentifierForSource(
  issue: LinearExport["issues"][number],
  source: LinearExport,
  options: LinearRepoExportOptions,
): string {
  const team = source.teams.find((candidate) => candidate.id === issue.teamId);
  if (!team) return issue.identifier;
  return issueIdentifierForExport(issue, team, options);
}
