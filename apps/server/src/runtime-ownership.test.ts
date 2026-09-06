import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimRuntimeOwnership } from "./runtime-ownership.ts";

const serverRoot = join(import.meta.dir, "..");
const children: Bun.Subprocess[] = [];
const tempDirectories: string[] = [];

function writeOwnershipMarker(metadataPath: string, leaseToken: string): void {
  const tokenHash = createHash("sha256").update(leaseToken).digest("hex").slice(0, 32);
  writeFileSync(join(dirname(metadataPath), `.owner-${tokenHash}`), `${leaseToken}\n`);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("runtime ownership handoff", () => {
  test("rejects a late child before it opens SQLite when the instance changed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prime-board-runtime-ownership-"));
    tempDirectories.push(directory);
    const projectRoot = join(directory, "project");
    const databasePath = join(directory, "late.db");
    const instanceMetadataPath = join(directory, "instance.json");
    const reservationMetadataPath = join(directory, "reservation.json");
    const newOwner = {
      version: 1,
      projectRoot,
      databasePath,
      port: 3333,
      pid: 999999,
      launcherPid: 999998,
      instanceId: "new-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(instanceMetadataPath, `${JSON.stringify(newOwner)}\n`);
    writeFileSync(
      reservationMetadataPath,
      `${JSON.stringify({
        version: 1,
        projectRoot,
        databasePath,
        pid: 999998,
        launcherPid: 999998,
        instanceId: "new-owner",
        reservedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const environment: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("PRIME_BOARD_")) delete environment[key];
    }
    Object.assign(environment, {
      PRIME_BOARD_REPO: projectRoot,
      PRIME_BOARD_DB: databasePath,
      PRIME_BOARD_PORT: "0",
      PRIME_BOARD_HOST: "127.0.0.1",
      PRIME_BOARD_AUTH_MODE: "local",
      PRIME_BOARD_INSTANCE_ID: "old-owner",
      PRIME_BOARD_INSTANCE_METADATA: instanceMetadataPath,
      PRIME_BOARD_LAUNCHER_PID: "999998",
      PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify([reservationMetadataPath]),
    });
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: serverRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);

    const result = await Promise.race([
      child.exited.then((exitCode) => ({ timedOut: false, exitCode })),
      new Promise<{ timedOut: true; exitCode: null }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true, exitCode: null }), 2_000),
      ),
    ]);
    if (result.timedOut && child.exitCode === null) child.kill("SIGKILL");
    if (result.timedOut) await child.exited;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("rejects a late child before SQLite when only the database reservation changed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prime-board-runtime-database-ownership-"));
    tempDirectories.push(directory);
    const projectRoot = join(directory, "project");
    const databasePath = join(directory, "late-database.db");
    const instanceMetadataPath = join(directory, "instance.json");
    const reservationMetadataPath = join(directory, "reservation.json");
    const instanceLeaseToken = "instance-lease-token";
    const oldDatabaseLeaseToken = "old-database-lease-token";
    const newDatabaseLeaseToken = "new-database-lease-token";
    writeFileSync(
      instanceMetadataPath,
      `${JSON.stringify({
        version: 1,
        projectRoot,
        databasePath,
        port: 3333,
        pid: 999999,
        launcherPid: 999998,
        instanceId: "old-owner",
        leaseToken: instanceLeaseToken,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    writeFileSync(
      reservationMetadataPath,
      `${JSON.stringify({
        version: 1,
        projectRoot,
        databasePath,
        pid: 999998,
        launcherPid: 999998,
        instanceId: "new-owner",
        leaseToken: newDatabaseLeaseToken,
        reservedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    writeOwnershipMarker(instanceMetadataPath, instanceLeaseToken);
    writeOwnershipMarker(reservationMetadataPath, newDatabaseLeaseToken);

    const environment: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("PRIME_BOARD_")) delete environment[key];
    }
    Object.assign(environment, {
      PRIME_BOARD_REPO: projectRoot,
      PRIME_BOARD_DB: databasePath,
      PRIME_BOARD_PORT: "3333",
      PRIME_BOARD_HOST: "127.0.0.1",
      PRIME_BOARD_AUTH_MODE: "local",
      PRIME_BOARD_INSTANCE_ID: "old-owner",
      PRIME_BOARD_INSTANCE_LEASE_TOKEN: instanceLeaseToken,
      PRIME_BOARD_INSTANCE_METADATA: instanceMetadataPath,
      PRIME_BOARD_LAUNCHER_PID: "999998",
      PRIME_BOARD_DATABASE_LEASE_TOKEN: oldDatabaseLeaseToken,
      PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify([reservationMetadataPath]),
    });
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: serverRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);

    const result = await Promise.race([
      child.exited.then((exitCode) => ({ timedOut: false, exitCode })),
      new Promise<{ timedOut: true; exitCode: null }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true, exitCode: null }), 2_000),
      ),
    ]);
    if (result.timedOut && child.exitCode === null) child.kill("SIGKILL");
    if (result.timedOut) await child.exited;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("rejects a late child before SQLite when the port reservation changed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prime-board-runtime-port-"));
    tempDirectories.push(directory);
    const projectRoot = join(directory, "project");
    const databasePath = join(directory, "late-port.db");
    const instanceMetadataPath = join(directory, "instance.json");
    const reservationMetadataPath = join(directory, "reservation.json");
    const portReservationMetadataPath = join(directory, "port-reservation.json");
    const owner = {
      version: 1,
      projectRoot,
      databasePath,
      port: 3333,
      pid: 999998,
      launcherPid: 999998,
      instanceId: "port-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(instanceMetadataPath, `${JSON.stringify(owner)}\n`);
    writeFileSync(
      reservationMetadataPath,
      `${JSON.stringify({
        version: 1,
        projectRoot,
        databasePath,
        pid: 999998,
        launcherPid: 999998,
        instanceId: "port-owner",
        reservedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    writeFileSync(
      portReservationMetadataPath,
      `${JSON.stringify({
        version: 1,
        port: 3334,
        pid: 999998,
        launcherPid: 999998,
        instanceId: "port-owner",
        reservedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const environment: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("PRIME_BOARD_")) delete environment[key];
    }
    Object.assign(environment, {
      PRIME_BOARD_REPO: projectRoot,
      PRIME_BOARD_DB: databasePath,
      PRIME_BOARD_PORT: "3333",
      PRIME_BOARD_HOST: "127.0.0.1",
      PRIME_BOARD_AUTH_MODE: "local",
      PRIME_BOARD_INSTANCE_ID: "port-owner",
      PRIME_BOARD_INSTANCE_METADATA: instanceMetadataPath,
      PRIME_BOARD_LAUNCHER_PID: "999998",
      PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify([reservationMetadataPath]),
      PRIME_BOARD_PORT_RESERVATION_METADATA: portReservationMetadataPath,
    });
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: serverRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);

    expect(await child.exited).not.toBe(0);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("claims matching project and database ownership before opening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prime-board-runtime-claim-"));
    const projectRoot = join(directory, "project");
    const databasePath = join(directory, "claimed.db");
    const instanceMetadataPath = join(directory, "instance.json");
    const reservationMetadataPath = join(directory, "reservation.json");
    const portReservationMetadataPath = join(directory, "port-reservation.json");
    const instanceId = "matching-owner";
    const launcherPid = process.pid;
    const instanceLeaseToken = "instance-lease-token";
    const databaseLeaseToken = "database-lease-token";
    const portLeaseToken = "port-lease-token";
    const previous = new Map<string, string | undefined>();
    const keys = [
      "PRIME_BOARD_INSTANCE_ID",
      "PRIME_BOARD_INSTANCE_LEASE_TOKEN",
      "PRIME_BOARD_DATABASE_LEASE_TOKEN",
      "PRIME_BOARD_PORT_LEASE_TOKEN",
      "PRIME_BOARD_INSTANCE_METADATA",
      "PRIME_BOARD_LAUNCHER_PID",
      "PRIME_BOARD_DATABASE_RESERVATION_METADATA",
      "PRIME_BOARD_PORT_RESERVATION_METADATA",
    ];
    for (const key of keys) previous.set(key, process.env[key]);
    try {
      writeFileSync(
        instanceMetadataPath,
        `${JSON.stringify({
          version: 1,
          projectRoot,
          databasePath,
          port: 3333,
          pid: launcherPid,
          launcherPid,
          instanceId,
          leaseToken: instanceLeaseToken,
          startedAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      writeFileSync(
        reservationMetadataPath,
        `${JSON.stringify({
          version: 1,
          projectRoot,
          databasePath,
          pid: launcherPid,
          launcherPid,
          instanceId,
          leaseToken: databaseLeaseToken,
          reservedAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      writeFileSync(
        portReservationMetadataPath,
        `${JSON.stringify({
          version: 1,
          port: 3333,
          pid: launcherPid,
          launcherPid,
          instanceId,
          leaseToken: portLeaseToken,
          reservedAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      writeOwnershipMarker(instanceMetadataPath, instanceLeaseToken);
      writeOwnershipMarker(reservationMetadataPath, databaseLeaseToken);
      writeOwnershipMarker(portReservationMetadataPath, portLeaseToken);
      Object.assign(process.env, {
        PRIME_BOARD_INSTANCE_ID: instanceId,
        PRIME_BOARD_INSTANCE_LEASE_TOKEN: instanceLeaseToken,
        PRIME_BOARD_DATABASE_LEASE_TOKEN: databaseLeaseToken,
        PRIME_BOARD_PORT_LEASE_TOKEN: portLeaseToken,
        PRIME_BOARD_INSTANCE_METADATA: instanceMetadataPath,
        PRIME_BOARD_LAUNCHER_PID: String(launcherPid),
        PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify([reservationMetadataPath]),
        PRIME_BOARD_PORT_RESERVATION_METADATA: portReservationMetadataPath,
      });

      expect(await claimRuntimeOwnership(projectRoot, databasePath, 3333)).toBe(true);
      expect(JSON.parse(readFileSync(instanceMetadataPath, "utf8"))).toMatchObject({
        pid: process.pid,
        serverPid: process.pid,
        instanceId,
        leaseToken: instanceLeaseToken,
        launcherPid,
      });
      expect(JSON.parse(readFileSync(reservationMetadataPath, "utf8"))).toMatchObject({
        pid: process.pid,
        serverPid: process.pid,
        instanceId,
        leaseToken: databaseLeaseToken,
        launcherPid,
      });
      expect(JSON.parse(readFileSync(portReservationMetadataPath, "utf8"))).toMatchObject({
        pid: process.pid,
        serverPid: process.pid,
        instanceId,
        leaseToken: portLeaseToken,
        launcherPid,
      });
      process.env.PRIME_BOARD_INSTANCE_LEASE_TOKEN = "wrong-instance-token";
      expect(await claimRuntimeOwnership(projectRoot, databasePath, 3333)).toBe(false);
      process.env.PRIME_BOARD_INSTANCE_LEASE_TOKEN = instanceLeaseToken;
      process.env.PRIME_BOARD_DATABASE_RESERVATION_METADATA = JSON.stringify([
        reservationMetadataPath,
        reservationMetadataPath,
      ]);
      expect(await claimRuntimeOwnership(projectRoot, databasePath, 3333)).toBe(false);
      process.env.PRIME_BOARD_DATABASE_RESERVATION_METADATA = JSON.stringify([]);
      expect(await claimRuntimeOwnership(projectRoot, databasePath, 3333)).toBe(false);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reclaims an incomplete transition before claiming matching ownership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prime-board-runtime-transition-"));
    const projectRoot = join(directory, "project");
    const databasePath = join(directory, "transition.db");
    const instanceMetadataPath = join(directory, "instance.json");
    const reservationMetadataPath = join(directory, "reservation.json");
    const instanceId = "transition-owner";
    const transitionPath = `${directory}.transition`;
    const previous = new Map<string, string | undefined>();
    const keys = [
      "PRIME_BOARD_INSTANCE_ID",
      "PRIME_BOARD_INSTANCE_METADATA",
      "PRIME_BOARD_LAUNCHER_PID",
      "PRIME_BOARD_DATABASE_RESERVATION_METADATA",
    ];
    for (const key of keys) previous.set(key, process.env[key]);
    try {
      writeFileSync(
        instanceMetadataPath,
        `${JSON.stringify({
          version: 1,
          projectRoot,
          databasePath,
          port: 3333,
          pid: process.pid,
          launcherPid: process.pid,
          instanceId,
          startedAt: "2026-01-01T00:00:00.000Z",
        })}
`,
      );
      writeFileSync(
        reservationMetadataPath,
        `${JSON.stringify({
          version: 1,
          projectRoot,
          databasePath,
          pid: process.pid,
          launcherPid: process.pid,
          instanceId,
          reservedAt: "2026-01-01T00:00:00.000Z",
        })}
`,
      );
      writeFileSync(
        transitionPath,
        `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`,
      );
      Object.assign(process.env, {
        PRIME_BOARD_INSTANCE_ID: instanceId,
        PRIME_BOARD_INSTANCE_METADATA: instanceMetadataPath,
        PRIME_BOARD_LAUNCHER_PID: String(process.pid),
        PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify([reservationMetadataPath]),
      });

      expect(await claimRuntimeOwnership(projectRoot, databasePath)).toBe(true);
      expect(existsSync(transitionPath)).toBe(false);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
