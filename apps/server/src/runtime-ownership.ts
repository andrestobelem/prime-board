import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
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

function reservationMetadataPaths(): string[] | null {
  const raw = process.env.PRIME_BOARD_DATABASE_RESERVATION_METADATA;
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((path) => typeof path !== "string" || path.length === 0 || path.trim() !== path)
    ) {
      return null;
    }
    if (new Set(value).size !== value.length) return null;
    return value;
  } catch {
    return null;
  }
}

function numericEnvironment(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalToken(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length > 0 && value.trim() === value)
  );
}

function ownershipMarkerPath(metadataPath: string, leaseToken: string): string {
  const tokenHash = createHash("sha256").update(leaseToken).digest("hex").slice(0, 32);
  return join(dirname(metadataPath), `.owner-${tokenHash}`);
}

function hasOwnershipMarker(metadataPath: string, leaseToken: string | undefined): boolean {
  if (leaseToken === undefined) return true;
  try {
    return (
      readFileSync(ownershipMarkerPath(metadataPath, leaseToken), "utf8").trim() === leaseToken
    );
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM también prueba que el proceso existe. Tratarlo como muerto podría
    // permitir que otro launcher retire un owner activo que no puede inspeccionar.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function transitionPath(directory: string): string {
  return `${directory}.transition`;
}

function transitionOwner(path: string): { pid: number; token: string } | null {
  for (const candidate of [join(path, "owner.json"), path]) {
    try {
      const value = JSON.parse(readFileSync(candidate, "utf8")) as {
        pid?: unknown;
        token?: unknown;
      };
      if (
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.token === "string" &&
        value.token.length > 0
      ) {
        return { pid: value.pid, token: value.token };
      }
    } catch {
      // Un owner malformed se trata abajo como una transición ocupada.
    }
  }
  return null;
}

function acquireTransition(directory: string): (() => void) | null {
  const path = transitionPath(directory);
  const recoveryGatePath = `${path}.recovery`;
  const token = randomUUID();

  const publish = (temporaryPath: string): boolean => {
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      linkSync(temporaryPath, path);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  const publishRecoveryGate = (recoveryToken: string): boolean => {
    const temporaryPath = `${recoveryGatePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ pid: process.pid, token: recoveryToken })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      linkSync(temporaryPath, recoveryGatePath);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Un gate stale se recupera con el mismo rename atómico que una transición
    // stale. Un gate malformed queda ocupado porque su owner es desconocido.
    if (existsSync(recoveryGatePath)) {
      const gateOwner = transitionOwner(recoveryGatePath);
      if (gateOwner === null || processIsAlive(gateOwner.pid)) return null;
      const gateQuarantinePath = `${recoveryGatePath}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
      try {
        renameSync(recoveryGatePath, gateQuarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      const quarantinedGateOwner = transitionOwner(gateQuarantinePath);
      if (quarantinedGateOwner !== null && processIsAlive(quarantinedGateOwner.pid)) {
        try {
          renameSync(gateQuarantinePath, recoveryGatePath);
        } catch {
          // No borres un gate que otro proceso haya publicado mientras tanto.
        }
        return null;
      }
      rmSync(gateQuarantinePath, { recursive: true, force: true });
      continue;
    }

    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    if (publish(temporaryPath)) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (transitionOwner(path)?.token === token) rmSync(path, { recursive: true, force: true });
      };
    }
    const owner = transitionOwner(path);
    if (owner === null || processIsAlive(owner.pid)) return null;
    if (existsSync(recoveryGatePath)) continue;

    const recoveryToken = randomUUID();
    if (!publishRecoveryGate(recoveryToken)) continue;
    let keepGate = false;
    try {
      // Lee de nuevo después de tomar el gate. Un reemplazo vivo indica que
      // la snapshot stale fue sustituida; nunca la muevas a quarantine.
      const current = transitionOwner(path);
      if (
        (current !== null && processIsAlive(current.pid)) ||
        (owner !== null && current?.token !== owner.token)
      ) {
        continue;
      }
      const quarantinePath = `${path}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
      try {
        renameSync(path, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        continue;
      }
      const quarantinedOwner = transitionOwner(quarantinePath);
      if (quarantinedOwner !== null && processIsAlive(quarantinedOwner.pid)) {
        try {
          renameSync(quarantinePath, path);
        } catch {
          // No borres un path que otro proceso haya publicado mientras tanto.
        }
        continue;
      }
      rmSync(quarantinePath, { recursive: true, force: true });
      const replacement = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
      if (!publish(replacement)) continue;
      keepGate = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (transitionOwner(path)?.token === token) rmSync(path, { recursive: true, force: true });
        if (transitionOwner(recoveryGatePath)?.token === recoveryToken) {
          rmSync(recoveryGatePath, { recursive: true, force: true });
        }
      };
    } finally {
      if (!keepGate && transitionOwner(recoveryGatePath)?.token === recoveryToken) {
        rmSync(recoveryGatePath, { recursive: true, force: true });
      }
    }
  }
  return null;
}
async function acquireTransitions(directories: string[]): Promise<(() => void)[] | null> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const releases: (() => void)[] = [];
    let acquired = true;
    for (const directory of directories) {
      const release = acquireTransition(directory);
      if (!release) {
        acquired = false;
        break;
      }
      releases.push(release);
    }
    if (acquired) return releases;
    for (const release of releases.reverse()) release();
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function matchesReservation(
  record: JsonRecord,
  projectRoot: string,
  databasePath: string,
  instanceId: string,
  launcherPid: number,
  leaseToken?: string,
  expectedPort?: number,
  instanceRecord = false,
): boolean {
  if (
    record.version !== 1 ||
    record.projectRoot !== projectRoot ||
    record.databasePath !== databasePath ||
    record.instanceId !== instanceId ||
    !isPositiveInteger(record.pid) ||
    !isOptionalPositiveInteger(record.launcherPid) ||
    !isOptionalPositiveInteger(record.serverPid) ||
    !isOptionalPositiveInteger(record.processGroupId) ||
    !isOptionalToken(record.leaseToken) ||
    (instanceRecord
      ? !isPositiveInteger(record.port) ||
        (expectedPort !== undefined && record.port !== expectedPort) ||
        typeof record.startedAt !== "string"
      : record.port !== undefined || typeof record.reservedAt !== "string") ||
    (leaseToken === undefined ? record.leaseToken !== undefined : record.leaseToken !== leaseToken)
  ) {
    return false;
  }
  return (
    record.pid === launcherPid || record.pid === process.pid || record.serverPid === process.pid
  );
}
function matchesPortReservation(
  record: JsonRecord,
  port: number,
  instanceId: string,
  launcherPid: number,
  leaseToken?: string,
): boolean {
  return (
    record.version === 1 &&
    isPositiveInteger(record.port) &&
    record.port === port &&
    record.instanceId === instanceId &&
    isPositiveInteger(record.pid) &&
    isOptionalPositiveInteger(record.launcherPid) &&
    isOptionalPositiveInteger(record.serverPid) &&
    isOptionalPositiveInteger(record.processGroupId) &&
    isOptionalToken(record.leaseToken) &&
    typeof record.reservedAt === "string" &&
    (leaseToken === undefined
      ? record.leaseToken === undefined
      : record.leaseToken === leaseToken) &&
    (record.pid === launcherPid || record.pid === process.pid || record.serverPid === process.pid)
  );
}

function claimedRecord(record: JsonRecord, launcherPid: number): JsonRecord {
  return {
    ...record,
    pid: process.pid,
    launcherPid: isPositiveInteger(record.launcherPid) ? record.launcherPid : launcherPid,
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
export async function claimRuntimeOwnership(
  projectRoot: string,
  databasePath: string,
  port?: number,
): Promise<boolean> {
  const metadataPath = process.env.PRIME_BOARD_INSTANCE_METADATA;
  const instanceId = process.env.PRIME_BOARD_INSTANCE_ID;
  const launcherPid = numericEnvironment("PRIME_BOARD_LAUNCHER_PID");
  const instanceLeaseToken = process.env.PRIME_BOARD_INSTANCE_LEASE_TOKEN;
  const databaseLeaseToken = process.env.PRIME_BOARD_DATABASE_LEASE_TOKEN;
  const portMetadataPath = process.env.PRIME_BOARD_PORT_RESERVATION_METADATA;
  const portLeaseToken = process.env.PRIME_BOARD_PORT_LEASE_TOKEN;
  const configuredPort = isPositiveInteger(port) ? port : null;
  const ownershipConfigured =
    metadataPath !== undefined ||
    instanceId !== undefined ||
    process.env.PRIME_BOARD_LAUNCHER_PID !== undefined ||
    process.env.PRIME_BOARD_DATABASE_RESERVATION_METADATA !== undefined ||
    portMetadataPath !== undefined ||
    instanceLeaseToken !== undefined ||
    databaseLeaseToken !== undefined ||
    portLeaseToken !== undefined;
  if (!ownershipConfigured) return true;
  if (!metadataPath || !instanceId || launcherPid === null) return false;
  if (
    !isOptionalToken(instanceLeaseToken) ||
    !isOptionalToken(databaseLeaseToken) ||
    !isOptionalToken(portLeaseToken)
  ) {
    return false;
  }
  if (portMetadataPath !== undefined && (!portMetadataPath || configuredPort === null)) {
    return false;
  }
  if (portLeaseToken !== undefined && portMetadataPath === undefined) return false;

  const configuredReservationPaths = reservationMetadataPaths();
  if (configuredReservationPaths === null || configuredReservationPaths.length === 0) return false;
  const reservationPaths = configuredReservationPaths;
  const transitionDirectories = [
    dirname(metadataPath),
    ...reservationPaths.map((path) => dirname(path)),
    ...(portMetadataPath ? [dirname(portMetadataPath)] : []),
  ].sort();
  const releases = await acquireTransitions([...new Set(transitionDirectories)]);
  if (!releases) return false;

  try {
    const instance = readJson(metadataPath);
    if (
      !instance ||
      !matchesReservation(
        instance,
        projectRoot,
        databasePath,
        instanceId,
        launcherPid,
        instanceLeaseToken,
        configuredPort ?? undefined,
        true,
      ) ||
      !hasOwnershipMarker(metadataPath, instanceLeaseToken)
    ) {
      return false;
    }
    const reservations = reservationPaths.map((path) => readJson(path));
    if (
      reservations.some(
        (record, index) =>
          !record ||
          !matchesReservation(
            record,
            projectRoot,
            databasePath,
            instanceId,
            launcherPid,
            databaseLeaseToken,
          ) ||
          !hasOwnershipMarker(reservationPaths[index]!, databaseLeaseToken),
      )
    ) {
      return false;
    }
    const portReservation = portMetadataPath ? readJson(portMetadataPath) : null;
    if (
      portMetadataPath !== undefined &&
      (configuredPort === null ||
        !portReservation ||
        !matchesPortReservation(
          portReservation,
          configuredPort,
          instanceId,
          launcherPid,
          portLeaseToken,
        ) ||
        !hasOwnershipMarker(portMetadataPath, portLeaseToken))
    ) {
      return false;
    }

    // Publica primero el owner del proyecto. El mismo lock de transición se
    // usa al retirar/tomar leases para que un child tardío no sobrescriba B.
    writeJsonAtomically(metadataPath, claimedRecord(instance, launcherPid));
    for (let index = 0; index < reservationPaths.length; index += 1) {
      writeJsonAtomically(
        reservationPaths[index]!,
        claimedRecord(reservations[index]!, launcherPid),
      );
    }
    if (portMetadataPath !== undefined && portReservation !== null) {
      writeJsonAtomically(portMetadataPath, claimedRecord(portReservation, launcherPid));
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
