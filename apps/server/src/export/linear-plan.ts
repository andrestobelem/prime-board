import { mergeSourceMap, type SourceMap } from "./source-map.ts";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
}

export interface ExistingIssue {
  identifier: string;
  sourceId?: string | null;
  title?: string | null;
}

export type IssuePlanAction = "create" | "update" | "conflict";

export interface IssuePlanItem {
  sourceId: string;
  targetIdentifier: string;
  action: IssuePlanAction;
}

export interface MigrationConflict {
  sourceId: string;
  identifier: string;
  code: "DUPLICATE_SOURCE_ID" | "IDENTIFIER_COLLISION" | "STALE_SOURCE_MAP" | "SOURCE_MAP_MISMATCH";
  message: string;
}

export interface LinearIssuePlan {
  items: IssuePlanItem[];
  conflicts: MigrationConflict[];
  sourceMap: SourceMap;
}

/**
 * Calcula la parte de issues del plan sin mutar la base ni resolver por nombres.
 * Los resultados se ordenan por source id para que el dry-run sea reproducible.
 */
export function buildLinearIssuePlan(
  sourceIssues: LinearIssue[],
  input: { existing: ExistingIssue[]; sourceMap: SourceMap },
): LinearIssuePlan {
  const existingByIdentifier = new Map(input.existing.map((issue) => [issue.identifier, issue]));
  const knownMappings = input.sourceMap.entities.issues ?? {};
  const seenSourceIds = new Set<string>();
  const seenIdentifiers = new Set<string>();
  const items: IssuePlanItem[] = [];
  const conflicts: MigrationConflict[] = [];
  const additions: Record<string, string> = {};

  const sorted = [...sourceIssues].sort(
    (a, b) => a.id.localeCompare(b.id) || a.identifier.localeCompare(b.identifier),
  );
  for (const issue of sorted) {
    const duplicateSource = seenSourceIds.has(issue.id);
    const duplicateIdentifier = seenIdentifiers.has(issue.identifier);
    seenSourceIds.add(issue.id);
    seenIdentifiers.add(issue.identifier);
    if (duplicateSource) {
      items.push({ sourceId: issue.id, targetIdentifier: issue.identifier, action: "conflict" });
      conflicts.push({
        sourceId: issue.id,
        identifier: issue.identifier,
        code: "DUPLICATE_SOURCE_ID",
        message: `Linear issue ${issue.id} appears more than once`,
      });
      continue;
    }
    if (duplicateIdentifier) {
      items.push({ sourceId: issue.id, targetIdentifier: issue.identifier, action: "conflict" });
      conflicts.push({
        sourceId: issue.id,
        identifier: issue.identifier,
        code: "IDENTIFIER_COLLISION",
        message: `Linear identifier ${issue.identifier} appears more than once in the export`,
      });
      continue;
    }

    const mappedIdentifier = knownMappings[issue.id];
    if (mappedIdentifier) {
      const existing = existingByIdentifier.get(mappedIdentifier);
      if (!existing) {
        items.push({ sourceId: issue.id, targetIdentifier: mappedIdentifier, action: "conflict" });
        conflicts.push({
          sourceId: issue.id,
          identifier: issue.identifier,
          code: "STALE_SOURCE_MAP",
          message: `Source map points ${issue.id} to missing ${mappedIdentifier}`,
        });
        continue;
      }
      if (existing.sourceId && existing.sourceId !== issue.id) {
        items.push({ sourceId: issue.id, targetIdentifier: mappedIdentifier, action: "conflict" });
        conflicts.push({
          sourceId: issue.id,
          identifier: issue.identifier,
          code: "SOURCE_MAP_MISMATCH",
          message: `${mappedIdentifier} belongs to source ${existing.sourceId}, not ${issue.id}`,
        });
        continue;
      }
      items.push({ sourceId: issue.id, targetIdentifier: mappedIdentifier, action: "update" });
      continue;
    }

    const existing = existingByIdentifier.get(issue.identifier);
    if (existing) {
      items.push({ sourceId: issue.id, targetIdentifier: issue.identifier, action: "conflict" });
      conflicts.push({
        sourceId: issue.id,
        identifier: issue.identifier,
        code: "IDENTIFIER_COLLISION",
        message: `${issue.identifier} already exists without a Linear source mapping`,
      });
      continue;
    }

    items.push({ sourceId: issue.id, targetIdentifier: issue.identifier, action: "create" });
    additions[issue.id] = issue.identifier;
  }

  return {
    items,
    conflicts,
    sourceMap: mergeSourceMap(input.sourceMap, "issues", additions),
  };
}
