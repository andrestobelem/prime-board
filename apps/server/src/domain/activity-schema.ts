// Fuente única del esquema de referencias de Activity (AT-187, candidato A del
// architecture review de AT-181 y AT-182..186).
//
// Qué campos del payload de cada ActivityType son ids que refieren a otra
// tabla, y cómo traducirlos en cada dirección (id ⇄ clave natural). Antes de
// esto, exporter.ts e importer.ts mantenían dos diccionarios calcados en
// espejo — uno por dirección — y el front (IssueView) no tenía ninguno, por
// eso mostraba texto genérico para las transiciones que no fueran priority
// (ver AT-190). Ahora los tres leen de acá.
import type { ActivityType } from "./activity.ts";

/** Las tablas a las que un campo de Activity puede referir. */
export type RefTable =
  "teams" | "states" | "actors" | "projects" | "milestones" | "cycles" | "issues";

export interface RefField {
  /** Campo en el payload interno (con ids). */
  field: string;
  /** Campo en el payload traducido (claves naturales o de vuelta a ids). Default: igual a `field`. */
  exportedAs?: string;
  table: RefTable;
  /**
   * "sparse" — los campos de state_changed/assigned/project_changed/etc: el
   *   campo solo se toca si está presente en el origen, y si el lookup no
   *   encuentra la clave se conserva el valor original (nunca se pierde info).
   * "dense" — el shape de `created`: el campo de salida siempre está
   *   presente, `null` si no había valor o si el lookup no encontró nada.
   */
  mode: "sparse" | "dense";
}

/**
 * Por ActivityType, los campos que son referencias a otra tabla. Los tipos
 * que no aparecen acá no tienen referencias (title_changed, description_changed,
 * priority_changed, sort_order_changed, labeled, unlabeled, relation_added,
 * relation_removed, archived) — o se
 * resuelven aparte por tener una regla propia ajena a tablas (`commented`:
 * recupera el body de un comentario histórico, ver exporter.ts/importer.ts).
 */
export const ACTIVITY_REFS: Partial<Record<ActivityType, RefField[]>> = {
  state_changed: [
    { field: "from", table: "states", mode: "sparse" },
    { field: "to", table: "states", mode: "sparse" },
  ],
  assigned: [
    { field: "from", table: "actors", mode: "sparse" },
    { field: "to", table: "actors", mode: "sparse" },
  ],
  project_changed: [
    { field: "from", table: "projects", mode: "sparse" },
    { field: "to", table: "projects", mode: "sparse" },
  ],
  milestone_changed: [
    { field: "from", table: "milestones", mode: "sparse" },
    { field: "to", table: "milestones", mode: "sparse" },
  ],
  cycle_changed: [
    { field: "from", table: "cycles", mode: "sparse" },
    { field: "to", table: "cycles", mode: "sparse" },
  ],
  parent_changed: [
    { field: "from", table: "issues", mode: "sparse" },
    { field: "to", table: "issues", mode: "sparse" },
  ],
  created: [
    { field: "teamId", exportedAs: "team", table: "teams", mode: "dense" },
    { field: "stateId", exportedAs: "state", table: "states", mode: "dense" },
    { field: "assigneeId", exportedAs: "assignee", table: "actors", mode: "dense" },
    { field: "parentId", exportedAs: "parent", table: "issues", mode: "dense" },
    { field: "projectId", exportedAs: "project", table: "projects", mode: "dense" },
    { field: "milestoneId", exportedAs: "milestone", table: "milestones", mode: "dense" },
  ],
};

/** Los 17 ActivityType existentes — usado por el test que exige cobertura total. */
export const ALL_ACTIVITY_TYPES: ActivityType[] = [
  "created",
  "title_changed",
  "description_changed",
  "state_changed",
  "priority_changed",
  "assigned",
  "parent_changed",
  "project_changed",
  "milestone_changed",
  "cycle_changed",
  "sort_order_changed",
  "labeled",
  "unlabeled",
  "relation_added",
  "relation_removed",
  "commented",
  "archived",
];

/**
 * Traduce los campos de referencia de un payload de Activity en la dirección
 * que indique `resolve` — id→clave natural (export) o clave natural→id
 * (import) son la misma función con un `resolve` distinto. `commented` no
 * pasa por acá: su traducción no es de tabla, es de recuperar el body.
 */
export function translateActivityRefs(
  type: string,
  payload: Record<string, unknown>,
  resolve: (table: RefTable, value: string) => string | null | undefined,
  /**
   * "toNaturalKeys" — export: lee `field` (id), escribe `exportedAs` (clave natural).
   * "toIds" — import: lee `exportedAs` (clave natural), escribe `field` (id).
   * Es la misma tabla de campos en las dos direcciones; solo cambia qué lado
   * se lee y cuál se escribe, así export/import dejan de mantener dos
   * diccionarios calcados en espejo (AT-187).
   */
  direction: "toNaturalKeys" | "toIds" = "toNaturalKeys",
): Record<string, unknown> {
  const fields = ACTIVITY_REFS[type as ActivityType];
  if (!fields) return payload;
  const result: Record<string, unknown> = { ...payload };
  for (const ref of fields) {
    const [readKey, writeKey] =
      direction === "toNaturalKeys"
        ? [ref.field, ref.exportedAs ?? ref.field]
        : [ref.exportedAs ?? ref.field, ref.field];
    if (ref.mode === "dense") {
      const value = result[readKey];
      if (writeKey !== readKey) delete result[readKey];
      // Dense snapshots always expose a stable field; an unresolvable deleted
      // resource is represented as null instead of leaking an internal UUID.
      result[writeKey] = typeof value === "string" ? (resolve(ref.table, value) ?? null) : null;
    } else {
      if (result[readKey] === undefined) continue;
      const value = result[readKey];
      if (typeof value === "string") {
        const resolved = resolve(ref.table, value);
        result[writeKey] = resolved ?? value;
      }
      if (writeKey !== readKey) delete result[readKey];
    }
  }
  return result;
}
