import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

let atomicWriteCounter = 0;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(path: string, value: JsonRecord): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${atomicWriteCounter++}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function reservationMetadataPaths(): string[] {
  const raw = process.env.PRIME_BOARD_DATABASE_RESERVATION_METADATA;
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

function numericEnvironment(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function matchesReservation(
  record: JsonRecord,
  projectRoot: string,
  databasePath: string,
  instanceId: string,
  launcherPid: number,
): boolean {
  if (
    record.version !== 1 ||
    record.projectRoot !== projectRoot ||
    record.databasePath !== databasePath ||
    record.instanceId !== instanceId
  ) {
    return false;
  }
  return (
    record.pid === launcherPid || record.pid === process.pid || record.serverPid === process.pid
  );
}

function claimedRecord(record: JsonRecord): JsonRecord {
  return {
    ...record,
    pid: process.pid,
    serverPid: process.pid,
    processGroupId: process.pid,
  };
}

/**
 * Reclama la metadata del launcher desde el proceso server.
 *
 * El launcher también hace este handoff después de spawn. El server lo repite
 * antes de abrir SQLite para que SIGKILL durante el handoff no deje al launcher
 * muerto como único propietario registrado.
 */
export function claimRuntimeOwnership(projectRoot: string, databasePath: string): void {
  const metadataPath = process.env.PRIME_BOARD_INSTANCE_METADATA;
  const instanceId = process.env.PRIME_BOARD_INSTANCE_ID;
  const launcherPid = numericEnvironment("PRIME_BOARD_LAUNCHER_PID");
  if (!metadataPath || !instanceId || launcherPid === null) return;

  // Publica primero el owner del proyecto. Esto cierra la ventana en la que un
  // launcher nuevo puede tomar la reserva antes de que el hijo abra SQLite.
  const instance = readJson(metadataPath);
  if (
    instance &&
    matchesReservation(instance, projectRoot, databasePath, instanceId, launcherPid)
  ) {
    writeJsonAtomically(metadataPath, claimedRecord(instance));
  }

  for (const path of reservationMetadataPaths()) {
    const record = readJson(path);
    if (record && matchesReservation(record, projectRoot, databasePath, instanceId, launcherPid)) {
      writeJsonAtomically(path, claimedRecord(record));
    }
  }
}
