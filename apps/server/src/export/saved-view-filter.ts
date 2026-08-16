// Referencias estables de los filtros de Saved View (PRB-244).
// Los filtros viven en JSON y no pueden conservar UUIDs porque el rebuild genera
// ids nuevos. La forma exportada usa las mismas claves naturales que el resto
// del repo y la transformación es recursiva para and/or.

export type SavedViewRefTable =
  "teams" | "states" | "actors" | "projects" | "milestones" | "labels" | "issues" | "cycles";

export type SavedViewFilterDirection = "toNaturalKeys" | "toIds";

export type SavedViewFilterResolver = (
  table: SavedViewRefTable,
  value: string,
) => string | undefined;

const ID_FIELDS: Record<string, SavedViewRefTable> = {
  team: "teams",
  state: "states",
  assignee: "actors",
  creator: "actors",
  project: "projects",
  milestone: "milestones",
  cycle: "cycles",
  parent: "issues",
  labels: "labels",
};

const COMPARATOR_FIELDS = new Set(["eq", "neq", "in", "nin", "includes", "includesAll"]);
const INTERNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateValue(
  value: unknown,
  table: SavedViewRefTable,
  path: string,
  resolve: SavedViewFilterResolver,
  direction: SavedViewFilterDirection,
  context: string,
): unknown {
  if (typeof value !== "string") return value;
  const translated = resolve(table, value);
  if (translated !== undefined) return translated;
  if (direction === "toNaturalKeys" && !INTERNAL_ID.test(value)) return value;
  const representation = direction === "toNaturalKeys" ? "internal ID" : "reference";
  throw new Error(
    `${context} filter ${path} contains unknown ${table} ${representation} "${value}"`,
  );
}

function translateComparator(
  comparator: unknown,
  table: SavedViewRefTable,
  path: string,
  resolve: SavedViewFilterResolver,
  direction: SavedViewFilterDirection,
  context: string,
): unknown {
  if (!isObject(comparator)) return comparator;
  const result: Record<string, unknown> = { ...comparator };
  for (const [key, value] of Object.entries(comparator)) {
    if (!COMPARATOR_FIELDS.has(key)) continue;
    result[key] = Array.isArray(value)
      ? value.map((item, index) =>
          translateValue(item, table, `${path}.${key}[${index}]`, resolve, direction, context),
        )
      : translateValue(value, table, `${path}.${key}`, resolve, direction, context);
  }
  return result;
}

export function translateSavedViewFilter(
  filter: unknown,
  resolve: SavedViewFilterResolver,
  direction: SavedViewFilterDirection,
  context = "Saved view",
): Record<string, unknown> {
  if (!isObject(filter)) {
    throw new Error(`${context} filter must be an object`);
  }
  const result: Record<string, unknown> = { ...filter };
  for (const [field, table] of Object.entries(ID_FIELDS)) {
    if (field in filter) {
      result[field] = translateComparator(
        filter[field],
        table,
        `.${field}`,
        resolve,
        direction,
        context,
      );
    }
  }
  for (const branch of ["and", "or"]) {
    if (Array.isArray(filter[branch])) {
      result[branch] = filter[branch].map((item, index) =>
        translateSavedViewFilter(item, resolve, direction, `${context} filter ${branch}[${index}]`),
      );
    }
  }
  return result;
}
