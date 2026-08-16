import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  const stageRoot = mkdtempSync(join(tmpdir(), "prime-board-linear-stage-"));
  const sourceResult = writeLinearExportToRepo(source, stageRoot, options);
  if (sourceResult.conflicts.length)
    throw new Error(`Linear merge has ${sourceResult.conflicts.length} source conflict(s)`);
  if (sourceResult.losses.length && !options.allowLosses)
    throw new Error(`Linear merge has ${sourceResult.losses.length} unapproved loss(es)`);
  const sourceBase = join(stageRoot, ".prime-board");
  const localBase = join(localRoot, ".prime-board");
  const outputBase = join(outputRoot, ".prime-board");
  if (existsSync(outputBase))
    throw new Error(`Output already contains .prime-board: ${outputRoot}`);
  copyFiles(join(sourceBase, "meta"), join(outputBase, "meta"));
  copyFiles(join(sourceBase, "issues"), join(outputBase, "issues"));
  copyFiles(join(sourceBase, "log"), join(outputBase, "log"));

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
  // Segunda pasada: snapshots y logs ven el mapa completo, incluidos padres y relaciones.
  for (const file of localIssues) {
    const meta = readIssueMeta(join(localIssueDir, file));
    const identifier = String(meta.id);
    const target = result.rekeyed[identifier];
    if (!target) continue;
    writeFileSync(
      join(outputBase, "issues", `${target}.md`),
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
        join(outputBase, "log", `${target}.jsonl`),
        replaceReferences(readFileSync(localLog, "utf8"), result.rekeyed, localKey, rekeyKey),
      );
  }

  const actors = readJson<any[]>(join(outputBase, "meta", "actors.json"));
  if (existsSync(join(localBase, "meta", "actors.json"))) {
    const seen = new Set(actors.map((actor) => actor.name));
    for (const actor of readJson<any[]>(join(localBase, "meta", "actors.json")))
      if (!seen.has(actor.name)) {
        actors.push(actor);
        seen.add(actor.name);
      }
  }
  writeJson(
    join(outputBase, "meta", "actors.json"),
    actors.sort((a, b) => a.name.localeCompare(b.name)),
  );

  const teams = readJson<any[]>(join(outputBase, "meta", "teams.json"));
  if (localTeam) {
    if (teams.some((team) => team.key === rekeyKey))
      result.conflicts.push({
        code: "REKEY_TEAM_EXISTS",
        message: `Team ${rekeyKey} already exists`,
      });
    else teams.push({ ...localTeam, key: rekeyKey, name: "prime-board dev" });
  }
  writeJson(
    join(outputBase, "meta", "teams.json"),
    teams.sort((a, b) => a.key.localeCompare(b.key)),
  );

  const workspaceLabels = readJson<any[]>(join(outputBase, "meta", "workspace-labels.json"));
  if (existsSync(join(localBase, "meta", "workspace-labels.json"))) {
    const seen = new Set(workspaceLabels.map((label) => label.name));
    for (const label of readJson<any[]>(join(localBase, "meta", "workspace-labels.json")))
      if (!seen.has(label.name)) {
        workspaceLabels.push(label);
        seen.add(label.name);
      }
  }
  writeJson(
    join(outputBase, "meta", "workspace-labels.json"),
    workspaceLabels.sort((a, b) => a.name.localeCompare(b.name)),
  );

  const projects = readJson<any[]>(join(outputBase, "meta", "projects.json"));
  const projectNames = new Set(projects.map((project) => project.name));
  if (existsSync(join(localBase, "meta", "projects.json")))
    for (const project of readJson<any[]>(join(localBase, "meta", "projects.json"))) {
      if (projectNames.has(project.name)) {
        result.conflicts.push({
          code: "PROJECT_NAME_COLLISION",
          message: `Project ${project.name} exists in both exports`,
        });
        continue;
      }
      projects.push({
        ...project,
        teams: (project.teams ?? []).map((key: string) => (key === localKey ? rekeyKey : key)),
      });
      projectNames.add(project.name);
    }
  writeJson(
    join(outputBase, "meta", "projects.json"),
    projects.sort((a, b) => a.name.localeCompare(b.name)),
  );

  rmSync(stageRoot, { recursive: true, force: true });
  return result;
}
