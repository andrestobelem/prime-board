/** Correspondencia estable entre entidades de Linear y sus claves en prime-board. */

export const SOURCE_MAP_VERSION = 1 as const;
export const SOURCE_ENTITY_TYPES = [
  "issues",
  "actors",
  "teams",
  "states",
  "labels",
  "projects",
  "milestones",
  "comments",
  "relations",
] as const;

export type SourceEntityType = (typeof SOURCE_ENTITY_TYPES)[number];
export type SourceEntityMaps = Partial<Record<SourceEntityType, Record<string, string>>>;

export interface SourceMap {
  version: typeof SOURCE_MAP_VERSION;
  source: "linear";
  workspaceId: string;
  entities: SourceEntityMaps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${label}`);
}

/** Crea un mapa vacío; el mapa no contiene secretos ni datos de autenticación. */
export function createSourceMap(workspaceId: string): SourceMap {
  assertNonEmptyString(workspaceId, "workspace id");
  return { version: SOURCE_MAP_VERSION, source: "linear", workspaceId, entities: {} };
}

/** Valida y normaliza un mapa leído desde JSON. */
export function parseSourceMap(value: unknown): SourceMap {
  if (!isRecord(value)) throw new Error("Invalid source map: expected object");
  if (value.version !== SOURCE_MAP_VERSION) throw new Error("Invalid source map version");
  if (value.source !== "linear") throw new Error("Invalid source map source");
  assertNonEmptyString(value.workspaceId, "workspace id");
  if (!isRecord(value.entities)) throw new Error("Invalid source map entities");

  const entities: SourceEntityMaps = {};
  for (const [entityType, rawMap] of Object.entries(value.entities)) {
    if (!(SOURCE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new Error(`Invalid source entity type: ${entityType}`);
    }
    if (!isRecord(rawMap)) throw new Error(`Invalid source map for ${entityType}`);
    const map: Record<string, string> = {};
    for (const [sourceId, target] of Object.entries(rawMap)) {
      assertNonEmptyString(sourceId, "source id");
      assertNonEmptyString(target, `target for ${sourceId}`);
      map[sourceId] = target;
    }
    entities[entityType as SourceEntityType] = map;
  }

  return {
    version: SOURCE_MAP_VERSION,
    source: "linear",
    workspaceId: value.workspaceId,
    entities,
  };
}

/** Agrega mappings sin mutar el mapa original; un remapeo distinto es un error. */
export function mergeSourceMap(
  current: SourceMap,
  entityType: SourceEntityType,
  additions: Record<string, string>,
): SourceMap {
  const base = parseSourceMap(current);
  const existing = { ...(base.entities[entityType] ?? {}) };
  for (const [sourceId, target] of Object.entries(additions)) {
    assertNonEmptyString(sourceId, "source id");
    assertNonEmptyString(target, `target for ${sourceId}`);
    if (existing[sourceId] && existing[sourceId] !== target) {
      throw new Error(`Source ${sourceId} is already mapped to ${existing[sourceId]}`);
    }
    existing[sourceId] = target;
  }
  return {
    ...base,
    entities: { ...base.entities, [entityType]: existing },
  };
}
