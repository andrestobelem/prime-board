import { describe, expect, test } from "bun:test";
import {
  acquireInstanceLock,
  classifyInstance,
  deriveProjectIdentity,
  chooseAvailablePort,
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
