import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  writeLinearExportToRepo,
  type LinearExport,
  type LinearRepoExportOptions,
  type LinearRepoExportResult,
} from "./linear-repo-export.ts";

export interface LinearMergeOptions extends LinearRepoExportOptions {
  localTeamKey?: string;
  rekeyTeamKey?: string;
}
export interface LinearMergeResult {
  source: LinearRepoExportResult;
  rekeyed: Record<string, string>;
  matched: string[];
  skipped: string[];
  conflicts: Array<{ code: string; message: string; identifier?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function mergeIssueLogs(outputPath: string, localPath: string): void {
  const events = [outputPath, localPath]
    .filter((path) => existsSync(path))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const unique = new Map(events.map((event) => [JSON.stringify(event), event]));
  const merged = [...unique.values()].sort((a, b) => {
    const ts = String(a.ts ?? "").localeCompare(String(b.ts ?? ""));
    return (
      ts ||
      String(a.type ?? "").localeCompare(String(b.type ?? "")) ||
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
  });
  writeFileSync(
    outputPath,
    merged.map((event) => JSON.stringify(event)).join("\n") + (merged.length ? "\n" : ""),
    "utf8",
  );
}
function copyFiles(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from))
    writeFileSync(join(to, file), readFileSync(join(from, file)));
}
function readIssueMeta(path: string): Record<string, any> {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`Invalid issue file: ${path}`);
  return parseYaml(match[1]!) as Record<string, any>;
}
function replaceReferences(
  raw: string,
  mapping: Record<string, string>,
  fromTeam: string,
  toTeam: string,
): string {
  let out = raw.replace(
    new RegExp(`\\b${fromTeam}-(\\d+)\\b`, "g"),
    (identifier) => mapping[identifier] ?? identifier,
  );
  out = out.replace(new RegExp(`(^team:\\s*)${fromTeam}(\\s*$)`, "gm"), `$1${toTeam}$2`);
  return out;
}

/**
 * Une una captura de Linear con el board local y aplica la decisión ADR-0006:
 * Linear queda en `AT` y los tickets locales colisionados pasan a `PRB`.
 *
 * El merge se planifica primero. Solo se publica el snapshot cuando no hay
 * conflictos: un reporte conflictivo nunca deja un `.prime-board` aplicable.
 * Escribe siempre en un directorio de salida explícito, nunca muta el origen.
 */
export function mergeLinearExportWithRepo(
  source: LinearExport,
  localRoot: string,
  outputRoot: string,
  options: LinearMergeOptions = {},
): LinearMergeResult {
  const localKey = (options.localTeamKey ?? "AT").toUpperCase();
  const rekeyKey = (options.rekeyTeamKey ?? "PRB").toUpperCase();
  const sourceStageRoot = mkdtempSync(join(tmpdir(), "prime-board-linear-stage-"));
  let mergeStageRoot: string | undefined;

  try {
    const sourceResult = writeLinearExportToRepo(source, sourceStageRoot, options);
    if (sourceResult.conflicts.length)
      throw new Error(`Linear merge has ${sourceResult.conflicts.length} source conflict(s)`);
    if (sourceResult.losses.length && !options.allowLosses)
      throw new Error(`Linear merge has ${sourceResult.losses.length} unapproved loss(es)`);

    const sourceBase = join(sourceStageRoot, ".prime-board");
    const localBase = join(localRoot, ".prime-board");
    const outputBase = join(outputRoot, ".prime-board");
    if (existsSync(outputBase))
      throw new Error(`Output already contains .prime-board: ${outputRoot}`);

    const result: LinearMergeResult = {
      source: sourceResult,
      rekeyed: {},
      matched: [],
      skipped: [],
      conflicts: [],
    };
    const sourceIssues = new Map<string, string>();
    for (const file of readdirSync(join(sourceBase, "issues"))) {
      const meta = readIssueMeta(join(sourceBase, "issues", file));
      sourceIssues.set(String(meta.id), String(meta.title));
    }
    const localIssueDir = join(localBase, "issues");
    const localIssues = existsSync(localIssueDir)
      ? readdirSync(localIssueDir).filter((file) => file.endsWith(".md"))
      : [];
    const usedRekeyNumbers = new Set<number>();
    for (const identifier of sourceIssues.keys())
      if (identifier.startsWith(`${rekeyKey}-`))
        usedRekeyNumbers.add(Number(identifier.slice(rekeyKey.length + 1)));
    const sourceTeams = readJson<any[]>(join(sourceBase, "meta", "teams.json"));
    const localTeam = existsSync(join(localBase, "meta", "teams.json"))
      ? (readJson<any[]>(join(localBase, "meta", "teams.json")).find(
          (team) => team.key === localKey,
        ) ?? null)
      : null;
    const localMeta = new Map<string, Record<string, any>>();
    for (const file of localIssues) {
      const meta = readIssueMeta(join(localIssueDir, file));
      localMeta.set(String(meta.id), meta);
    }
    // Primera pasada: asigna todos los destinos antes de reescribir referencias.
    for (const identifier of [...localMeta.keys()].sort()) {
      const meta = localMeta.get(identifier)!;
      if (!identifier.startsWith(`${localKey}-`)) {
        result.skipped.push(identifier);
        continue;
      }
      if (sourceIssues.get(identifier) === String(meta.title)) {
        result.matched.push(identifier);
        continue;
      }
      const number = Number(identifier.slice(localKey.length + 1));
      let targetNumber = number;
      while (usedRekeyNumbers.has(targetNumber)) targetNumber += 1;
      usedRekeyNumbers.add(targetNumber);
      result.rekeyed[identifier] = `${rekeyKey}-${targetNumber}`;
    }

    // Todos los conflictos del merge se calculan antes de crear o modificar
    // cualquier salida. Esto incluye los conflictos de metadata que antes se
    // descubrían después de copiar el snapshot Linear.
    if (localTeam && sourceTeams.some((team) => team.key === rekeyKey))
      result.conflicts.push({
        code: "REKEY_TEAM_EXISTS",
        message: `Team ${rekeyKey} already exists`,
      });

    const sourceProjects = readJson<any[]>(join(sourceBase, "meta", "projects.json"));
    const sourceProjectNames = new Set(sourceProjects.map((project) => project.name));
    const localProjects = existsSync(join(localBase, "meta", "projects.json"))
      ? readJson<any[]>(join(localBase, "meta", "projects.json"))
      : [];
    for (const project of localProjects)
      if (sourceProjectNames.has(project.name))
        result.conflicts.push({
          code: "PROJECT_NAME_COLLISION",
          message: `Project ${project.name} exists in both exports`,
        });

    // No destino publicado ni snapshot aplicable en presencia de conflictos.
    if (result.conflicts.length > 0) return result;

    // Segunda pasada: el snapshot se construye en staging. Se publica de una
    // sola vez al final, después de completar todas las escrituras.
    mergeStageRoot = mkdtempSync(join(tmpdir(), "prime-board-linear-merge-"));
    const stagedBase = join(mergeStageRoot, ".prime-board");
    copyFiles(join(sourceBase, "meta"), join(stagedBase, "meta"));
    copyFiles(join(sourceBase, "issues"), join(stagedBase, "issues"));
    copyFiles(join(sourceBase, "log"), join(stagedBase, "log"));

    // Segunda pasada: snapshots y logs ven el mapa completo, incluidos padres y relaciones.
    for (const file of localIssues) {
      const meta = readIssueMeta(join(localIssueDir, file));
      const identifier = String(meta.id);
      const target = result.rekeyed[identifier];
      if (!target) continue;
      writeFileSync(
        join(stagedBase, "issues", `${target}.md`),
        replaceReferences(
          readFileSync(join(localIssueDir, file), "utf8"),
          result.rekeyed,
          localKey,
          rekeyKey,
        ),
      );
      const localLog = join(localBase, "log", file.replace(/\.md$/, ".jsonl"));
      if (existsSync(localLog))
        writeFileSync(
          join(stagedBase, "log", `${target}.jsonl`),
          replaceReferences(readFileSync(localLog, "utf8"), result.rekeyed, localKey, rekeyKey),
        );
    }

    for (const identifier of result.matched) {
      const localLog = join(localBase, "log", `${identifier}.jsonl`);
      const outputLog = join(stagedBase, "log", `${identifier}.jsonl`);
      mergeIssueLogs(outputLog, localLog);
    }

    const actors = readJson<any[]>(join(stagedBase, "meta", "actors.json"));
    if (existsSync(join(localBase, "meta", "actors.json"))) {
      const seen = new Set(actors.map((actor) => actor.name));
      for (const actor of readJson<any[]>(join(localBase, "meta", "actors.json")))
        if (!seen.has(actor.name)) {
          actors.push(actor);
          seen.add(actor.name);
        }
    }
    writeJson(
      join(stagedBase, "meta", "actors.json"),
      actors.sort((a, b) => a.name.localeCompare(b.name)),
    );

    const teams = readJson<any[]>(join(stagedBase, "meta", "teams.json"));
    if (localTeam) teams.push({ ...localTeam, key: rekeyKey, name: "prime-board dev" });
    writeJson(
      join(stagedBase, "meta", "teams.json"),
      teams.sort((a, b) => a.key.localeCompare(b.key)),
    );

    const workspaceLabels = readJson<any[]>(join(stagedBase, "meta", "workspace-labels.json"));
    if (existsSync(join(localBase, "meta", "workspace-labels.json"))) {
      const seen = new Set(workspaceLabels.map((label) => label.name));
      for (const label of readJson<any[]>(join(localBase, "meta", "workspace-labels.json")))
        if (!seen.has(label.name)) {
          workspaceLabels.push(label);
          seen.add(label.name);
        }
    }
    writeJson(
      join(stagedBase, "meta", "workspace-labels.json"),
      workspaceLabels.sort((a, b) => a.name.localeCompare(b.name)),
    );

    const projects = sourceProjects;
    const projectNames = sourceProjectNames;
    for (const project of localProjects) {
      const mappedTeams = (project.teams ?? [])
        .map((key: string) => (key === localKey ? rekeyKey : key))
        .filter((key: string) => key !== "PB");
      if (mappedTeams.length === 0) continue;
      projects.push({ ...project, teams: mappedTeams });
      projectNames.add(project.name);
    }
    writeJson(
      join(stagedBase, "meta", "projects.json"),
      projects.sort((a, b) => a.name.localeCompare(b.name)),
    );

    const migrationReportPath = join(stagedBase, "meta", "migration-report.json");
    const migrationReport = readJson<Record<string, unknown>>(migrationReportPath);
    migrationReport.localMerge = {
      localTeam: localKey,
      rekeyTeam: rekeyKey,
      rekeyed: result.rekeyed,
      matched: result.matched,
      skipped: result.skipped,
      conflicts: result.conflicts,
    };
    writeJson(migrationReportPath, migrationReport);

    // Publicación atómica del snapshot: el destino no se crea hasta que todas
    // las validaciones y escrituras de la planificación terminaron.
    mkdirSync(outputRoot, { recursive: true });
    renameSync(stagedBase, outputBase);
    return result;
  } finally {
    rmSync(sourceStageRoot, { recursive: true, force: true });
    if (mergeStageRoot) rmSync(mergeStageRoot, { recursive: true, force: true });
  }
}
