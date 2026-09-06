import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, visit } from "graphql";
import { typeDefs } from "@prime-board/schema";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

const EXPECTED_PUBLIC_DESCRIPTIONS = [
  "Absolute HTTP(S) URL for the profile avatar.",
  "Workspaces granted to this Actor through the current credential.",
  "The default destination for issues created without an explicit state. Editable through teamUpdate.",
  "NULL for Workspace labels.",
  "Team IDs allowed by this key; empty means every Team.",
  "Plaintext token; returned only when the invitation is created.",
  "Plaintext API key; returned only when the invitation is accepted.",
  "Readable, immutable identifier, for example AT-126.",
  "0 none, 1 urgent, 2 high, 3 medium, 4 low (as in Linear).",
  "Actors that follow this issue.",
  "Relations with other issues (blocking, related, and duplicates), from both ends.",
  "Append-only history of changes to the issue.",
  "Deep link to the UI.",
  "Suggested branch name, for example agent/at-126-title.",
  "This issue blocks the related issue.",
  "This issue is blocked by the related issue.",
  "Symmetric relation: both ends see the same relation.",
  "This issue duplicates the related issue.",
  "The related issue duplicates this issue.",
  "Relation between two issues, viewed from the queried issue.",
  "Type from the perspective of the queried issue (the other end sees the inverse).",
  "The issue at the other end.",
  "Entry in the viewer's personal inbox (PRB-202).",
  "Time-boxed cycle for a Team (PRB-203).",
  "Completed / total issues (excluding archived issues).",
  "Review request for an issue (PRB-205).",
  "Workspace initiative that groups projects (PRB-206).",
  "Completed / total issues in the initiative's projects.",
  "History of narrative updates (PRB-207).",
  "Narrative project update (status, risks, and next steps).",
  "Completed issues divided by total issues (0..1).",
  "Must be a state in the Team.",
  "Absolute HTTP(S) URL for the profile avatar.",
  "Absolute HTTP(S) URL for the profile avatar.",
  "Plaintext key. Returned once; only its hash is stored.",
  "Omit to create a Workspace label.",
  "Number of issues from which the label was removed.",
  "Issues moved to the destination state.",
  "true: the field is NULL; false: the field is not NULL.",
  "Composable filter: fields combine with AND; and/or nest sub-filters.",
  "Full-text search over the title and description.",
  "Issues followed by (or not followed by) the authenticated actor.",
  "true: open issues with all blockers closed (frontier); false: issues with at least one open blocker.",
  "Sets the identifier number (for imports); default: automatic numbering.",
  "Labels to apply at creation (avoids an extra issueUpdate).",
  "Original creation date (imports); default: now.",
  "Original author (imports); default: the API key actor.",
  "Replaces the complete set of labels.",
  "Accepts a UUID or readable identifier (AT-126).",
  "Type from the perspective of issueId; normalized when stored.",
  "Accepts a UUID or readable identifier (AT-126).",
  "Original date (imports); default: now.",
  "Original author (imports); default: the API key actor.",
  "Project Teams; omit = all current Teams (compatibility behavior).",
  "Replaces the complete set of project Teams.",
  "Omit to generate automatically; returned once.",
  'Subscribed events; omit for all events ("*").',
  "Secret used to sign deliveries. Save it; it is not shown again.",
  "Number of issues left without a milestone.",
  "Saved view: reusable filters, ordering, and grouping (PRB-201).",
  "Serialized IssueFilter (JSON).",
  "UI grouping criterion: state | milestone | assignee | priority.",
  "Visible list columns (field IDs).",
  "Effective ViewPreferences for the current Actor.",
  "Slack delivery is persisted as intent. A Slack transport is not part of this slice.",
  "Actor authenticated by the API key in the Authorization header.",
  "Workspaces accessible to the current Actor and credential.",
  "Accepts a UUID or readable identifier (AT-126).",
  "Labels visible to a Team (Workspace + Team labels); without a Team, all labels.",
  "Views visible to the viewer. With teamId: Team + Workspace + personal views.",
  "Events relevant to the authenticated actor (assignments and comments on their issues).",
  "Viewer review queue (as reviewer or requester).",
  "Deletes the state; moveToStateId is required when it has issues.",
  "Deletes the milestone; assigned issues are left without a milestone.",
  "Moves open issues from the source cycle to the destination cycle.",
] as const;

function normalizedMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function backendTableRow(document: string, backend: "SQLite" | "PostgreSQL"): string {
  const row = document.split("\n").find((line) => line.startsWith(`| **${backend}**`));
  if (!row) throw new Error(`Missing ${backend} row in the canonical backend table`);
  return row
    .trim()
    .replace(/^\| |\|$/g, "")
    .split("|")
    .map((cell) => normalizedMarkdown(cell))
    .join(" | ");
}

function backendBullet(document: string, backend: "SQLite" | "PostgreSQL"): string {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`- **${backend}**`));
  if (start < 0) throw new Error(`Missing ${backend} summary in the persistence audit`);
  const end = lines.findIndex(
    (line, index) => index > start && (line.startsWith("- **") || line.startsWith("Por eso,")),
  );
  return normalizedMarkdown(lines.slice(start, end < 0 ? lines.length : end).join(" "));
}

const EXPECTED_SQLITE_TABLE_ROW =
  "**SQLite** | `bun:sqlite`, archivo definido por `PRIME_BOARD_DB`, migraciones `0001`–`0030`. | Es el camino operativo completo. La migración `0030` retira Documents después de validar el archivo externo; el esquema vigente conserva FTS5 y el soporte de Workspace Context.";
const EXPECTED_POSTGRES_TABLE_ROW =
  "**PostgreSQL** | Se activa con `PRIME_BOARD_PERSISTENCE=postgres` y requiere `PRIME_BOARD_POSTGRES_URL`; usa migraciones independientes `0001`–`0011`. `0010` agrega la tabla `projector_checkpoints` y `0011` retira Documents después de validar el archivo externo. | Mantiene una única Workspace y tiene cobertura incremental. Los paths directos cubren Actors, autenticación, API keys y límites de Team, Teams, Issues, Relations, Projects, Milestones, Cycles, Labels, Activity, suscriptores, Reviews, Initiatives, Project Updates, Saved Views, Favorites, Inbox y Webhooks. Relations está implementado por PRB-437; API keys y límites de Team usan `0008` y `0009` por PRB-552. `workspaceCreate` sigue sin migrar. Comments no tiene persistencia PostgreSQL y el event log canónico con su proyector Repository Source → PostgreSQL sigue pendiente según ADR-0019 y PRB-445/453. El SQLite efímero solo sirve como compatibilidad para dominios sin path PG.";
const EXPECTED_SQLITE_AUDIT_BULLET =
  "- **SQLite** es el backend predeterminado. Usa `bun:sqlite`, migraciones `0001`–`0030` y conserva el esquema histórico de Documents solo durante la migración y no expone esa capacidad.";
const EXPECTED_POSTGRES_AUDIT_BULLET =
  "- **PostgreSQL** es opcional. Se activa con `PRIME_BOARD_PERSISTENCE=postgres`, requiere `PRIME_BOARD_POSTGRES_URL`, usa migraciones independientes `0001`–`0011` y conserva una única Workspace. `0010` agrega la tabla `projector_checkpoints` para checkpoints durables del projector. La migración es incremental: los dominios sin path PG usan un SQLite efímero o devuelven un error explícito. `0005` agrega Documents por compatibilidad histórica; `0011` los retira después de validar el archivo externo. `0006` suscriptores, `0007` Memberships y grants de Workspace, `0008` el alcance de Workspace de los límites de Team de API keys y `0009` el grant explícito del Workspace efectivo. Los paths directos incluyen Issues, Teams, Projects, Milestones, Cycles, Labels, Activity, suscriptores, Relations, API keys y límites de Team. Relations tiene lectura y mutaciones desde PRB-437; API keys y límites desde PRB-552. Comments no tiene una ruta de persistencia PostgreSQL. El event log canónico y el proyector Repository Source → PostgreSQL siguen pendientes según ADR-0019 y PRB-445/453.";

function publicDescriptions(): string[] {
  const descriptions: string[] = [];
  visit(parse(typeDefs), {
    enter(node) {
      const description = (node as { description?: { value?: unknown } }).description;
      if (typeof description?.value === "string") descriptions.push(description.value);
    },
  });
  return descriptions;
}

describe("public GraphQL documentation", () => {
  it("keeps SDL descriptions in English for the public API", () => {
    const descriptions = publicDescriptions();
    expect(descriptions).toEqual([...EXPECTED_PUBLIC_DESCRIPTIONS]);
  });

  it("documents the canonical SQLite and PostgreSQL selection and gaps", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    const guide = readFileSync(resolve(REPO_ROOT, "docs/guia-agentes.md"), "utf8");
    const scope = readFileSync(resolve(REPO_ROOT, "docs/alcance-mvp.md"), "utf8");
    const audit = readFileSync(resolve(REPO_ROOT, "docs/audits/linear-paridad-graphql.md"), "utf8");

    expect(readme).toContain("PRIME_BOARD_PERSISTENCE=postgres");
    expect(readme).toContain("PRIME_BOARD_POSTGRES_URL");
    expect(readme).toContain("SQLite es el valor predeterminado");
    expect(readme).toContain("no hay paridad completa entre backends");
    expect(readme).not.toContain("La API GraphQL opera sobre SQLite");
    expect(guide).toContain("El endpoint GraphQL es el mismo con ambos backends");
    expect(guide).toContain("PRIME_BOARD_PERSISTENCE=postgres");
    expect(guide).toContain("PRIME_BOARD_POSTGRES_URL");

    expect(backendTableRow(scope, "SQLite")).toBe(EXPECTED_SQLITE_TABLE_ROW);
    expect(backendTableRow(scope, "PostgreSQL")).toBe(EXPECTED_POSTGRES_TABLE_ROW);
    expect(scope).toContain(
      "No se debe presentar PostgreSQL como un reemplazo con paridad de persistencia.",
    );
    expect(scope).toContain("una operación puede no estar migrada en PostgreSQL.");

    expect(backendBullet(audit, "SQLite")).toBe(EXPECTED_SQLITE_AUDIT_BULLET);
    expect(backendBullet(audit, "PostgreSQL")).toBe(EXPECTED_POSTGRES_AUDIT_BULLET);
    expect(audit).toContain(
      "Por eso, un campo o una mutación presente en el SDL no implica que todos los backends la\nsoporten.",
    );
  });
});
