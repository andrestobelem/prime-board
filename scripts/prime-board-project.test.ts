import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireDatabaseReservation,
  acquireInstanceLock,
  classifyInstance,
  databaseReservationPaths,
  promoteDatabaseReservationOwner,
  promoteInstanceOwner,
  deriveProjectIdentity,
  chooseAvailablePort,
  reserveAvailablePort,
  resolveInstanceStatus,
  retireInstanceLock,
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

  test("reclaims a stale legacy database reservation", () => {
    const home = `/tmp/prime-board-db-legacy-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-legacy-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const legacyRecord = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 999999,
      instanceId: "legacy-owner",
      reservedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const path of databaseReservationPaths(identity.databasePath, home)) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "reservation.json"), `${JSON.stringify(legacyRecord)}\n`);
    }
    let release: (() => void) | null = null;
    try {
      release = acquireDatabaseReservation(
        identity,
        { ...legacyRecord, instanceId: "new-owner" },
        () => false,
      );
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        expect(JSON.parse(readFileSync(join(path, "reservation.json"), "utf8")).instanceId).toBe(
          "new-owner",
        );
      }
    } finally {
      release?.();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims a stale tokenized database reservation", () => {
    const home = `/tmp/prime-board-db-tokenized-stale-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-db-tokenized-stale-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const oldRecord = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 999999,
      launcherPid: 999998,
      instanceId: "old-owner",
      leaseToken: "old-database-token",
      reservedAt: "2026-01-01T00:00:00.000Z",
    };
    const releaseOld = acquireDatabaseReservation(identity, oldRecord, () => false);
    let releaseNew: (() => void) | null = null;
    try {
      releaseNew = acquireDatabaseReservation(
        identity,
        {
          ...oldRecord,
          pid: 999997,
          launcherPid: 999996,
          instanceId: "new-owner",
          leaseToken: "new-database-token",
          reservedAt: "2026-01-01T00:00:01.000Z",
        },
        () => false,
      );
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        expect(JSON.parse(readFileSync(join(path, "reservation.json"), "utf8"))).toMatchObject({
          instanceId: "new-owner",
          leaseToken: "new-database-token",
        });
      }
    } finally {
      releaseNew?.();
      releaseOld();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims a stale tokenized port reservation", async () => {
    const home = `/tmp/prime-board-port-tokenized-stale-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const oldReservation = await reserveAvailablePort(
      3333,
      true,
      home,
      async () => true,
      "old-owner",
    );
    let newReservation: { port: number; release: () => void } | null = null;
    try {
      const oldMetadata = JSON.parse(readFileSync(join(lockPath, "reservation.json"), "utf8"));
      writeFileSync(
        join(lockPath, "reservation.json"),
        `${JSON.stringify({ ...oldMetadata, pid: 999999, launcherPid: 999998, serverPid: 999999 })}\n`,
      );
      newReservation = await reserveAvailablePort(3333, true, home, async () => true, "new-owner");
      expect(JSON.parse(readFileSync(join(lockPath, "reservation.json"), "utf8"))).toMatchObject({
        instanceId: "new-owner",
      });
    } finally {
      newReservation?.release();
      oldReservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an interrupted database reservation", () => {
    const home = `/tmp/prime-board-db-interrupted-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-interrupted-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const record = (instanceId: string) => ({
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 1234,
      instanceId,
      reservedAt: "2026-01-01T00:00:00.000Z",
    });
    const releaseOld = acquireDatabaseReservation(identity, record("old-owner"), () => false);
    let releaseNew: (() => void) | null = null;
    try {
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        rmSync(join(path, "reservation.json"), { force: true });
        writeFileSync(join(path, "reservation.json.tmp-crash"), "partial");
        writeFileSync(
          `${path}.transition`,
          `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`,
        );
      }
      releaseNew = acquireDatabaseReservation(identity, record("new-owner"), () => false);
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        expect(existsSync(join(path, "reservation.json"))).toBe(true);
        expect(existsSync(join(path, "reservation.json.tmp-crash"))).toBe(false);
      }
    } finally {
      releaseNew?.();
      releaseOld();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not take over an incomplete database reservation while its owner lives", () => {
    const home = `/tmp/prime-board-db-live-incomplete-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-db-live-incomplete-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const release = acquireDatabaseReservation(identity, {
      version: 1,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: process.pid,
      instanceId: "live-owner",
      reservedAt: "2026-01-01T00:00:00.000Z",
    });
    try {
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        rmSync(join(path, "reservation.json"), { force: true });
      }
      expect(() =>
        acquireDatabaseReservation(identity, {
          version: 1,
          projectRoot: identity.projectRoot,
          databasePath: identity.databasePath,
          pid: process.pid,
          instanceId: "new-owner",
          reservedAt: "2026-01-01T00:00:01.000Z",
        }),
      ).toThrow("Database reservation is incomplete");
    } finally {
      release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an empty database reservation after a stale transition", () => {
    const home = `/tmp/prime-board-db-empty-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-empty-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const transitionPath = `${identity.databaseLockPath}.transition`;
    mkdirSync(dirname(identity.databaseLockPath), { recursive: true });
    mkdirSync(identity.databaseLockPath);
    writeFileSync(
      transitionPath,
      `${JSON.stringify({ pid: 999999, token: "dead-transition" })}
`,
    );
    let release: (() => void) | null = null;
    try {
      release = acquireDatabaseReservation(
        identity,
        {
          version: 1,
          projectRoot: identity.projectRoot,
          databasePath: identity.databasePath,
          pid: 1234,
          instanceId: "new-owner",
          reservedAt: "2026-01-01T00:00:00.000Z",
        },
        () => false,
      );
      expect(existsSync(join(identity.databaseLockPath, "reservation.json"))).toBe(true);
    } finally {
      release?.();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not remove a replacement database reservation", () => {
    const home = `/tmp/prime-board-db-replacement-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-replacement-${crypto.randomUUID()}.db`;
    const identity = deriveProjectIdentity("/tmp/projects/alpha", home, databasePath);
    const record = (instanceId: string) => ({
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      pid: 1234,
      instanceId,
      reservedAt: "2026-01-01T00:00:00.000Z",
    });
    const releaseOld = acquireDatabaseReservation(identity, record("same-owner"), () => false);
    try {
      for (const path of databaseReservationPaths(identity.databasePath, home)) {
        rmSync(path, { recursive: true, force: true });
      }
      const releaseNew = acquireDatabaseReservation(identity, record("same-owner"), () => false);
      try {
        releaseOld();
        for (const path of databaseReservationPaths(identity.databasePath, home)) {
          expect(existsSync(join(path, "reservation.json"))).toBe(true);
        }
      } finally {
        releaseNew();
      }
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
      expect(after.databasePhysicalLockPath).toBe(before.databasePhysicalLockPath);
      expect(after.databaseInodeLockPath).not.toBeNull();
      expect(() => acquireDatabaseReservation(after, record, () => true)).toThrow(
        "Database is already reserved",
      );
      const targetIdentity = deriveProjectIdentity("/tmp/projects/beta", home, target);
      expect(targetIdentity.databasePhysicalLockPath).toBe(before.databasePhysicalLockPath);
      expect(() =>
        acquireDatabaseReservation(
          targetIdentity,
          {
            ...record,
            projectRoot: targetIdentity.projectRoot,
            databasePath: targetIdentity.databasePath,
          },
          () => true,
        ),
      ).toThrow("Database is already reserved");
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
      expect(first.databaseInodeLockPath).toBe(second.databaseInodeLockPath);
      expect(first.databaseInodeLockPath).not.toBeNull();
      expect(() => acquireDatabaseReservation(second, record(second), () => true)).toThrow(
        "Database is already reserved",
      );
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed database ownership metadata", () => {
    const home = `/tmp/prime-board-db-malformed-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity(
      "/tmp/projects/alpha",
      home,
      `/tmp/prime-board-malformed-${crypto.randomUUID()}.db`,
    );
    mkdirSync(identity.databaseLockPath, { recursive: true });
    writeFileSync(
      join(identity.databaseLockPath, "reservation.json"),
      JSON.stringify({
        version: 1,
        projectRoot: identity.projectRoot,
        databasePath: identity.databasePath,
        pid: 0,
        instanceId: {},
        reservedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
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

  test("reclaims a stale legacy project lock", () => {
    const home = `/tmp/prime-board-instance-legacy-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/legacy", home);
    const legacyRecord = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3333,
      pid: 999999,
      instanceId: "legacy-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    mkdirSync(identity.lockPath, { recursive: true });
    writeFileSync(identity.metadataPath, `${JSON.stringify(legacyRecord)}\n`);
    try {
      const status = classifyInstance(identity, () => false);
      expect(status.record).toMatchObject(legacyRecord);
      retireInstanceLock(identity, status.record ?? undefined);
      const release = acquireInstanceLock(identity, { ...legacyRecord, instanceId: "new-owner" });
      release();
      expect(existsSync(identity.lockPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps a stale child lock while its launcher is still alive", () => {
    const home = `/tmp/prime-board-instance-launcher-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/launcher", home);
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3333,
      pid: 999999,
      launcherPid: process.pid,
      serverPid: 999998,
      instanceId: "launcher-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const release = acquireInstanceLock(identity, record);
    try {
      expect(classifyInstance(identity).state).toBe("running");
      retireInstanceLock(identity, record);
      expect(existsSync(identity.metadataPath)).toBe(true);
    } finally {
      release();
      rmSync(home, { recursive: true, force: true });
    }
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

  test("keeps malformed instance metadata occupied without a recovery proof", () => {
    const home = `/tmp/prime-board-instance-malformed-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/malformed", home);
    mkdirSync(identity.lockPath, { recursive: true });
    writeFileSync(
      identity.metadataPath,
      JSON.stringify({
        version: 1,
        projectRoot: identity.projectRoot,
        databasePath: identity.databasePath,
        port: 3333,
        pid: 0,
        instanceId: {},
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    try {
      const status = classifyInstance(identity, () => false);
      expect(status.state).toBe("stale");
      expect(() => retireInstanceLock(identity, status.record ?? undefined)).not.toThrow();
      expect(existsSync(identity.lockPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not retire malformed metadata after recovering a stale transition", () => {
    const home = `/tmp/prime-board-instance-malformed-recovery-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/malformed-recovery", home);
    const transitionPath = `${identity.lockPath}.transition`;
    mkdirSync(identity.lockPath, { recursive: true });
    writeFileSync(
      identity.metadataPath,
      JSON.stringify({
        version: 1,
        projectRoot: identity.projectRoot,
        databasePath: identity.databasePath,
        port: 3333,
        pid: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(transitionPath, `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`);
    try {
      retireInstanceLock(identity);
      expect(existsSync(identity.lockPath)).toBe(true);
      expect(existsSync(identity.metadataPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an empty instance lock after a stale transition", () => {
    const home = `/tmp/prime-board-instance-empty-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/empty", home);
    const transitionPath = `${identity.lockPath}.transition`;
    mkdirSync(identity.lockPath, { recursive: true });
    writeFileSync(`${identity.metadataPath}.tmp-crash`, "partial");
    writeFileSync(transitionPath, `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`);
    try {
      const status = classifyInstance(identity, () => false);
      expect(status.state).toBe("stale");
      expect(status.record).toBeNull();
      retireInstanceLock(identity, status.record ?? undefined);
      expect(existsSync(identity.lockPath)).toBe(false);
      const release = acquireInstanceLock(identity, {
        version: 1,
        projectRoot: identity.projectRoot,
        databasePath: identity.databasePath,
        port: 3333,
        pid: process.pid,
        instanceId: "new-owner",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      release();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("blocks a healthy child when database ownership promotion fails", async () => {
    const home = `/tmp/prime-board-instance-blocked-${crypto.randomUUID()}`;
    const databasePath = `/tmp/prime-board-instance-blocked-${crypto.randomUUID()}.db`;
    const projectRoot = "/tmp/projects/blocked";
    const identity = deriveProjectIdentity(projectRoot, home, databasePath);
    const instanceId = "blocked-owner";
    const leaseToken = "blocked-instance-token";
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 0,
      pid: 999999,
      launcherPid: 999998,
      instanceId,
      leaseToken,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    mkdirSync(identity.lockPath, { recursive: true });
    mkdirSync(dirname(identity.databaseLockPath), { recursive: true });
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({
        port: 0,
        fetch: () =>
          Response.json({
            status: "ok",
            pid: process.pid,
            projectRoot: identity.projectRoot,
            databasePath: identity.databasePath,
            instanceId,
            leaseToken,
          }),
      });
      writeFileSync(identity.metadataPath, `${JSON.stringify({ ...record, port: server.port })}\n`);

      const status = await resolveInstanceStatus(identity);

      expect(status.state).toBe("blocked");
      expect(status.record).toMatchObject({
        pid: process.pid,
        instanceId,
        leaseToken,
      });
      expect(JSON.parse(readFileSync(identity.metadataPath, "utf8")).pid).toBe(process.pid);
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      server?.stop(true);
      rmSync(home, { recursive: true, force: true });
      rmSync(databasePath, { force: true });
    }
  });

  test("does not take over while a launcher transition is live", () => {
    const home = `/tmp/prime-board-instance-transition-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/transition", home);
    const transitionPath = `${identity.lockPath}.transition`;
    mkdirSync(dirname(transitionPath), { recursive: true });
    writeFileSync(
      transitionPath,
      `${JSON.stringify({ pid: process.pid, token: "live-transition" })}
`,
    );
    try {
      expect(() =>
        acquireInstanceLock(identity, {
          version: 1,
          projectRoot: identity.projectRoot,
          databasePath: identity.databasePath,
          port: 3333,
          pid: 1234,
          instanceId: "new-owner",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow("ownership transition is busy");
      expect(existsSync(transitionPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not take over a malformed transition", () => {
    const home = `/tmp/prime-board-instance-malformed-transition-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/malformed-transition", home);
    const transitionPath = `${identity.lockPath}.transition`;
    mkdirSync(dirname(transitionPath), { recursive: true });
    writeFileSync(transitionPath, "partial");
    try {
      expect(() =>
        acquireInstanceLock(identity, {
          version: 1,
          projectRoot: identity.projectRoot,
          databasePath: identity.databasePath,
          port: 3333,
          pid: 1234,
          instanceId: "new-owner",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow("ownership transition is busy");
      expect(existsSync(transitionPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an interrupted instance metadata write", () => {
    const home = `/tmp/prime-board-instance-interrupted-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/interrupted", home);
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3333,
      pid: 1234,
      instanceId: "interrupted-owner",
      leaseToken: crypto.randomUUID(),
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const release = acquireInstanceLock(identity, record);
    try {
      rmSync(identity.metadataPath, { force: true });
      writeFileSync(`${identity.metadataPath}.tmp-crash`, "partial");
      writeFileSync(
        `${identity.lockPath}.transition`,
        `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`,
      );
      retireInstanceLock(identity, record);
      expect(existsSync(identity.lockPath)).toBe(false);
      const next = acquireInstanceLock(identity, { ...record, instanceId: "new-owner" });
      next();
    } finally {
      release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not remove a replacement project lock", () => {
    const home = `/tmp/prime-board-instance-replacement-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/beta", home);
    const record = (instanceId: string) => ({
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3334,
      pid: 1234,
      instanceId,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const releaseOld = acquireInstanceLock(identity, record("old-owner"));
    try {
      rmSync(identity.lockPath, { recursive: true, force: true });
      const releaseNew = acquireInstanceLock(identity, record("new-owner"));
      try {
        releaseOld();
        const metadata = JSON.parse(readFileSync(identity.metadataPath, "utf8")) as {
          instanceId?: string;
        };
        expect(metadata.instanceId).toBe("new-owner");
      } finally {
        releaseNew();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not retire a project lock after the child claims it", () => {
    const home = `/tmp/prime-board-instance-claim-${crypto.randomUUID()}`;
    const identity = deriveProjectIdentity("/tmp/projects/claim", home);
    const record = {
      version: 1 as const,
      projectRoot: identity.projectRoot,
      databasePath: identity.databasePath,
      port: 3333,
      pid: 999999,
      launcherPid: 999999,
      instanceId: "claimed-owner",
      leaseToken: crypto.randomUUID(),
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const release = acquireInstanceLock(identity, record);
    try {
      promoteInstanceOwner(identity, { pid: process.pid }, record.instanceId, record.leaseToken);
      retireInstanceLock(identity, record);
      expect(existsSync(identity.metadataPath)).toBe(true);
      expect(JSON.parse(readFileSync(identity.metadataPath, "utf8")).pid).toBe(process.pid);
    } finally {
      release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("transfers project and database ownership to the child", () => {
  const home = `/tmp/prime-board-handoff-test-${crypto.randomUUID()}`;
  const identity = deriveProjectIdentity(
    "/tmp/projects/handoff",
    home,
    `/tmp/prime-board-handoff-${crypto.randomUUID()}.db`,
  );
  const instanceId = crypto.randomUUID();
  const instanceLeaseToken = crypto.randomUUID();
  const databaseLeaseToken = crypto.randomUUID();
  const instanceRecord = {
    version: 1 as const,
    projectRoot: identity.projectRoot,
    databasePath: identity.databasePath,
    port: 3333,
    pid: 1111,
    launcherPid: 1111,
    instanceId,
    leaseToken: instanceLeaseToken,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const reservationRecord = {
    version: 1 as const,
    projectRoot: identity.projectRoot,
    databasePath: identity.databasePath,
    pid: 1111,
    launcherPid: 1111,
    instanceId,
    leaseToken: databaseLeaseToken,
    reservedAt: "2026-01-01T00:00:00.000Z",
  };
  const releaseInstance = acquireInstanceLock(identity, instanceRecord);
  const releaseDatabase = acquireDatabaseReservation(identity, reservationRecord, () => false);
  try {
    promoteInstanceOwner(
      identity,
      { pid: 2222, processGroupId: 2222 },
      instanceId,
      instanceLeaseToken,
    );
    promoteDatabaseReservationOwner(
      identity,
      { pid: 2222, processGroupId: 2222 },
      instanceId,
      databaseLeaseToken,
    );

    expect(classifyInstance(identity, (pid) => pid === 2222).state).toBe("running");
    const metadata = JSON.parse(readFileSync(identity.metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({ pid: 2222, serverPid: 2222, launcherPid: 1111 });
  } finally {
    releaseDatabase();
    releaseInstance();
    rmSync(home, { recursive: true, force: true });
  }
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

  test("reclaims a stale legacy port reservation", async () => {
    const home = `/tmp/prime-board-port-legacy-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "reservation.json"),
      `${JSON.stringify({
        version: 1,
        port: 3333,
        pid: 999999,
        reservedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    let reservation: { port: number; release: () => void } | null = null;
    try {
      reservation = await reserveAvailablePort(3333, true, home, async () => true);
      expect(reservation.port).toBe(3333);
    } finally {
      reservation?.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an interrupted port reservation", async () => {
    const home = `/tmp/prime-board-port-interrupted-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const oldReservation = await reserveAvailablePort(3333, false, home, async () => true);
    let newReservation: { port: number; release: () => void } | null = null;
    try {
      rmSync(join(lockPath, "reservation.json"), { force: true });
      writeFileSync(join(lockPath, "reservation.json.tmp-crash"), "partial");
      writeFileSync(
        `${lockPath}.transition`,
        `${JSON.stringify({ pid: 999999, token: "dead-transition" })}\n`,
      );
      newReservation = await reserveAvailablePort(3333, true, home, async () => true);
      expect(newReservation.port).toBe(3333);
      expect(existsSync(join(lockPath, "reservation.json.tmp-crash"))).toBe(false);
    } finally {
      newReservation?.release();
      oldReservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects malformed port ownership metadata", async () => {
    const home = `/tmp/prime-board-port-malformed-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "reservation.json"),
      JSON.stringify({ version: 1, port: 0, pid: 0, instanceId: {}, reservedAt: "invalid" }),
    );
    try {
      await expect(reserveAvailablePort(3333, true, home, async () => true)).rejects.toThrow(
        "Port 3333 is already in use",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not take over an incomplete port reservation while its owner lives", async () => {
    const home = `/tmp/prime-board-port-live-incomplete-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const reservation = await reserveAvailablePort(
      3333,
      true,
      home,
      async () => true,
      "live-owner",
    );
    try {
      rmSync(join(lockPath, "reservation.json"), { force: true });
      await expect(
        reserveAvailablePort(3333, true, home, async () => true, "new-owner"),
      ).rejects.toThrow("Port 3333 is already in use");
    } finally {
      reservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reclaims an empty port reservation after a stale transition", async () => {
    const home = `/tmp/prime-board-port-empty-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const transitionPath = `${lockPath}.transition`;
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeFileSync(
      transitionPath,
      `${JSON.stringify({ pid: 999999, token: "dead-transition" })}
`,
    );
    let reservation: { port: number; release: () => void } | null = null;
    try {
      reservation = await reserveAvailablePort(3333, true, home, async () => true);
      expect(reservation.port).toBe(3333);
    } finally {
      reservation?.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("transfers port ownership to the child", async () => {
    const home = `/tmp/prime-board-port-handoff-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const reservation = await reserveAvailablePort(3333, true, home, async () => true);
    try {
      reservation.promoteOwner({ pid: 2222, processGroupId: 2222 });
      expect(JSON.parse(readFileSync(join(lockPath, "reservation.json"), "utf8"))).toMatchObject({
        pid: 2222,
        launcherPid: process.pid,
        serverPid: 2222,
        processGroupId: 2222,
      });
    } finally {
      reservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps a port reservation while its launcher is still alive", async () => {
    const home = `/tmp/prime-board-port-launcher-${crypto.randomUUID()}`;
    const reservation = await reserveAvailablePort(3333, true, home, async () => true);
    try {
      reservation.promoteOwner({ pid: 999999, processGroupId: 999999 });
      await expect(reserveAvailablePort(3333, true, home, async () => true)).rejects.toThrow(
        "Port 3333 is already in use",
      );
    } finally {
      reservation.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not remove a replacement port reservation", async () => {
    const home = `/tmp/prime-board-port-replacement-${crypto.randomUUID()}`;
    const lockPath = join(home, ".prime-board", "ports", "3333.lock");
    const oldReservation = await reserveAvailablePort(
      3333,
      false,
      home,
      async () => true,
      "same-owner",
    );
    try {
      rmSync(lockPath, { recursive: true, force: true });
      const newReservation = await reserveAvailablePort(
        3333,
        false,
        home,
        async () => true,
        "same-owner",
      );
      try {
        oldReservation.release();
        expect(existsSync(join(lockPath, "reservation.json"))).toBe(true);
      } finally {
        newReservation.release();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
