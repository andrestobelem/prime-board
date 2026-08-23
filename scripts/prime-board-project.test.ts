import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  acquireDatabaseReservation,
  acquireInstanceLock,
  classifyInstance,
  deriveProjectIdentity,
  chooseAvailablePort,
  reserveAvailablePort,
} from "./prime-board-project-lib.ts";

describe("project instance identity", () => {
  test("derives independent global paths from the repository root", () => {
    const alpha = deriveProjectIdentity("/tmp/projects/alpha", "/tmp/home");
    const beta = deriveProjectIdentity("/tmp/projects/beta", "/tmp/home");

    expect(alpha).toMatchObject({
      projectRoot: "/tmp/projects/alpha",
      databasePath: "/tmp/home/.prime-board/projects/alpha-7720c953.db",
      lockPath: "/tmp/home/.prime-board/projects/alpha-7720c953.lock",
    });
    expect(beta.databasePath).not.toBe(alpha.databasePath);
    expect(beta.lockPath).not.toBe(alpha.lockPath);
  });
});

describe("atomic project database reservations", () => {
  test("serializes reservations for the same database across projects", () => {
    const home = `/tmp/prime-board-db-test-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-shared-${crypto.randomUUID()}.db`;
    const firstIdentity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const secondIdentity = deriveProjectIdentity("/tmp/projects/beta", home, databasePath);
    const record = (identity: typeof firstIdentity) => ({
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 1234,
      reservedAt: "2026-01-01T00:00:00.000Z",
    });
    try {
      const release = acquireDatabaseReservation(firstIdentity, record(firstIdentity), () => true);
      expect(secondIdentity.databaseLockPath).toBe(firstIdentity.databaseLockPath);
      expect(() =>
        acquireDatabaseReservation(secondIdentity, record(secondIdentity), () => true),
      ).toThrow("Database is already reserved");
      release();
      const next = acquireDatabaseReservation(secondIdentity, record(secondIdentity), () => true);
      next();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps a dangling symlink alias lock stable and rejects a second reservation", () => {
    const root = `/tmp/prime-board-db-symlink-${crypto.randomUUID()}`;
    const home = `${root}/home`;
    const target = `${root}/target.db`;
    const alias = `${root}/alias.db`;
    mkdirSync(root, { recursive: true });
    symlinkSync(target, alias);
    const before = deriveProjectIdentity("/tmp/projects/alpha", home, alias);
    const record = {
      version: 1 as const,
      projectRoot: before.projectRoot,
      databasePath: before.databasePath,
      pid: 1234,
      reservedAt: "2026-01-01T00:00:00.000Z",
    };
    const release = acquireDatabaseReservation(before, record, () => true);
    try {
      writeFileSync(target, "database");
      const after = deriveProjectIdentity("/tmp/projects/alpha", home, alias);
      expect(after.databasePath).toBe(before.databasePath);
      expect(after.databaseLockPath).toBe(before.databaseLockPath);
      expect(after.databasePhysicalLockPath).not.toBeNull();
      expect(() => acquireDatabaseReservation(after, record, () => true)).toThrow(
        "Database is already reserved",
      );
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shares a physical database reservation across hardlink aliases", () => {
    const root = `/tmp/prime-board-db-hardlink-${crypto.randomUUID()}`;
    const home = `${root}/home`;
    const source = `${root}/source.db`;
    const alias = `${root}/alias.db`;
    mkdirSync(root, { recursive: true });
    writeFileSync(source, "database");
    linkSync(source, alias);
    const first = deriveProjectIdentity("/tmp/projects/alpha", home, source);
    const second = deriveProjectIdentity("/tmp/projects/beta", home, alias);
    const record = (identity: typeof first) => ({
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 1234,
      reservedAt: "2026-01-01T00:00:00.000Z",
    });
    const release = acquireDatabaseReservation(first, record(first), () => true);
    try {
      expect(first.databasePhysicalLockPath).toBe(second.databasePhysicalLockPath);
      expect(first.databasePhysicalLockPath).not.toBeNull();
      expect(() => acquireDatabaseReservation(second, record(second), () => true)).toThrow(
        "Database is already reserved",
      );
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not take an incomplete database reservation", () => {
    const home = `/tmp/prime-board-db-test-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity(
      "/tmp/projects/alpha",
      home,
      `/tmp/prime-board-shared-${crypto.randomUUID()}.db`,
    );
    mkdirSync(identity.databaseLockPath, { recursive: true });
    try {
      expect(() =>
        acquireDatabaseReservation(
          identity,
          {
            version: 1,
            projectRoot: identity.projectRoot,
            databasePath: identity.databasePath,
            pid: 1234,
            reservedAt: "2026-01-01T00:00:00.000Z",
          },
          () => false,
        ),
      ).toThrow("Database reservation is incomplete");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("project instance lock", () => {
  test("reuses a live instance and reports a released lock as not running", () => {
    const home = `/tmp/prime-board-test-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home);
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3333,
      pid: 1234,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    const release = acquireInstanceLock(identity, record);
    expect(classifyInstance(identity, () => true).state).toBe("running");
    expect(() => acquireInstanceLock(identity, record)).toThrow("already running");

    release();
    expect(classifyInstance(identity, () => true).state).toBe("not-running");
  });

  test("reports a dead owner as stale", () => {
    const home = `/tmp/prime-board-test-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/beta", home);
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3334,
      pid: 5678,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    const release = acquireInstanceLock(identity, record);
    expect(classifyInstance(identity, () => false).state).toBe("stale");
    release();
  });
});

describe("project instance ports", () => {
  test("moves the implicit default to the next free port", async () => {
    const selected = await chooseAvailablePort(3333, false, async (port) => port !== 3333);
    expect(selected).toBe(3334);
  });

  test("rejects an explicitly occupied port", async () => {
    await expect(chooseAvailablePort(3333, true, async () => false)).rejects.toThrow(
      "Port 3333 is already in use",
    );
  });
});

describe("atomic project port reservations", () => {
  test("serializes implicit selection across concurrent projects", async () => {
    const home = `/tmp/prime-board-port-test-${crypto.randomUUID()}`;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    try {
      const firstPromise = reserveAvailablePort(3333, false, home, async (port) => {
        if (port === 3333) {
          probeStarted();
          await probeReleased;
        }
        return true;
      });
      await started;

      const second = await reserveAvailablePort(3333, false, home, async () => true);
      expect(second.port).toBe(3334);
      releaseProbe();
      const first = await firstPromise;
      expect(first.port).toBe(3333);

      first.release();
      second.release();
      expect(
        await reserveAvailablePort(3333, true, home, async () => true).then(({ port, release }) => {
          release();
          return port;
        }),
      ).toBe(3333);
    } finally {
      releaseProbe?.();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps the explicit occupied-port error for another reservation", async () => {
    const home = `/tmp/prime-board-port-test-${crypto.randomUUID()}`;
    const reservation = await reserveAvailablePort(3333, false, home, async () => true);
    try {
      await expect(reserveAvailablePort(3333, true, home, async () => true)).rejects.toThrow(
        "Port 3333 is already in use",
      );
    } finally {
      reservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
