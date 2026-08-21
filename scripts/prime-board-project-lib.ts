import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectInstanceIdentity {
  projectRoot: string;
  projectSlug: string;
  projectHash: string;
  databasePath: string;
  lockPath: string;
  metadataPath: string;
}

export function deriveProjectIdentity(
  projectRoot: string,
  homeDirectory = homedir(),
  databasePathOverride?: string,
): ProjectInstanceIdentity {
  const root = resolve(projectRoot);
  const projectSlug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") || "project";
  const projectHash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const projectStateRoot = join(resolve(homeDirectory), ".prime-board", "projects");
  const projectKey = `${projectSlug}-${projectHash}`;
  const lockPath = join(projectStateRoot, `${projectKey}.lock`);

  return {
    projectRoot: root,
    projectSlug,
    projectHash,
    databasePath: resolve(databasePathOverride ?? join(projectStateRoot, `${projectKey}.db`)),
    lockPath,
    metadataPath: join(lockPath, "instance.json"),
  };
}

export interface InstanceRecord {
  version: 1;
  projectRoot: string;
  databasePath: string;
  port: number;
  pid: number;
  startedAt: string;
}

export type InstanceState = "running" | "stale" | "not-running";

export interface InstanceStatus {
  state: InstanceState;
  record: InstanceRecord | null;
}

export type ProcessProbe = (pid: number) => boolean;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readInstanceRecord(identity: ProjectInstanceIdentity): InstanceRecord | null {
  if (!existsSync(identity.metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(identity.metadataPath, "utf8")) as InstanceRecord;
  } catch {
    return null;
  }
}

export function classifyInstance(
  identity: ProjectInstanceIdentity,
  probe: ProcessProbe = processIsAlive,
): InstanceStatus {
  if (!existsSync(identity.lockPath)) return { state: "not-running", record: null };
  const record = readInstanceRecord(identity);
  if (
    !record ||
    record.version !== 1 ||
    record.projectRoot !== identity.projectRoot ||
    !Number.isInteger(record.pid) ||
    !probe(record.pid)
  ) {
    return { state: "stale", record };
  }
  return { state: "running", record };
}

export function removeInstanceLock(identity: ProjectInstanceIdentity): void {
  rmSync(identity.lockPath, { recursive: true, force: true });
}

export function retireInstanceLock(identity: ProjectInstanceIdentity): void {
  const quarantinePath = `${identity.lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(identity.lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

export function acquireInstanceLock(
  identity: ProjectInstanceIdentity,
  record: InstanceRecord,
): () => void {
  mkdirSync(dirname(identity.lockPath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(identity.lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Project instance already running: ${identity.projectRoot}`);
    }
    throw error;
  }
  try {
    writeFileSync(identity.metadataPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    removeInstanceLock(identity);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeInstanceLock(identity);
  };
}

export type PortProbe = (port: number) => Promise<boolean>;

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailability) => {
    const server = createServer();
    server.once("error", () => resolveAvailability(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolveAvailability(true));
    });
  });
}

export async function chooseAvailablePort(
  preferredPort: number,
  explicit: boolean,
  probe: PortProbe = portIsAvailable,
): Promise<number> {
  if (await probe(preferredPort)) return preferredPort;
  if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
  for (let port = preferredPort + 1; port <= 65535; port += 1) {
    if (await probe(port)) return port;
  }
  throw new Error(`No available port found after ${preferredPort}`);
}

export interface PortReservation {
  port: number;
  release: () => void;
}

interface PortReservationRecord {
  version: 1;
  port: number;
  pid: number;
  reservedAt: string;
}

function portReservationPath(homeDirectory: string, port: number): string {
  return join(resolve(homeDirectory), ".prime-board", "ports", `${port}.lock`);
}

function readPortReservation(path: string): PortReservationRecord | "invalid" | null {
  const metadataPath = join(path, "reservation.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf8")) as PortReservationRecord;
    if (record.version !== 1 || !Number.isInteger(record.pid) || record.port <= 0) {
      return "invalid";
    }
    return record;
  } catch {
    return "invalid";
  }
}

function retirePortReservation(path: string): void {
  const quarantinePath = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

function acquirePortReservation(homeDirectory: string, port: number): (() => void) | null {
  const path = portReservationPath(homeDirectory, port);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const record: PortReservationRecord = {
        version: 1,
        port,
        pid: process.pid,
        reservedAt: new Date().toISOString(),
      };
      writeFileSync(join(path, "reservation.json"), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      const record = readPortReservation(path);
      // A newly-created directory can be observed before its metadata is written.
      // Keep malformed or incomplete reservations occupied instead of stealing them.
      if (record === null || record === "invalid") return null;
      if (processIsAlive(record.pid)) return null;
      retirePortReservation(path);
    }
  }
  return null;
}

/**
 * Atomically reserves a loopback port for the launcher startup window.
 * The reservation stays held until the child server exits or startup fails.
 */
export async function reserveAvailablePort(
  preferredPort: number,
  explicit: boolean,
  homeDirectory = homedir(),
  probe: PortProbe = portIsAvailable,
): Promise<PortReservation> {
  for (let port = preferredPort; port <= 65535; port += 1) {
    const release = acquirePortReservation(homeDirectory, port);
    if (!release) {
      if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
      continue;
    }
    let available = false;
    try {
      available = await probe(port);
    } catch (error) {
      release();
      throw error;
    }
    if (available) return { port, release };
    release();
    if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
  }
  throw new Error(`No available port found after ${preferredPort}`);
}
