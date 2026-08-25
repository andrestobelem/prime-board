import { describe, expect, test } from "bun:test";
import { parseRuntimeArgs } from "../src/options.ts";

describe("prime-board runtime CLI", () => {
  test("parses paths and port for an isolated runtime", () => {
    const parsed = parseRuntimeArgs([
      "--db",
      "/tmp/board.db",
      "--repo=/tmp/project",
      "--port",
      "34567",
      "--web-dist",
      "/tmp/web",
    ]);
    expect(parsed).toEqual({
      dbPath: "/tmp/board.db",
      repoRoot: "/tmp/project",
      port: 34567,
      webDist: "/tmp/web",
      help: false,
    });
  });

  test("parses the project launcher options", () => {
    expect(
      parseRuntimeArgs([
        "--project",
        "/tmp/project with spaces",
        "--host=127.0.0.1",
        "--status",
        "--web-dist",
        "/tmp/web",
      ]),
    ).toEqual({
      projectRoot: "/tmp/project with spaces",
      host: "127.0.0.1",
      status: true,
      webDist: "/tmp/web",
      help: false,
    });
  });

  test("parses backup and update actions", () => {
    expect(parseRuntimeArgs(["--backup", "/tmp/backup.sqlite"])).toEqual({
      backupPath: "/tmp/backup.sqlite",
      help: false,
    });
    expect(parseRuntimeArgs(["--update"])).toEqual({ update: true, help: false });
    expect(parseRuntimeArgs(["--restore=/tmp/backup.sqlite"])).toEqual({
      restorePath: "/tmp/backup.sqlite",
      help: false,
    });
  });

  test("rejects invalid ports, hosts, and conflicting actions", () => {
    expect(() => parseRuntimeArgs(["--port", "0"])).toThrow("Invalid port");
    expect(() => parseRuntimeArgs(["--host", "bad host"])).toThrow("Invalid host");
    expect(() => parseRuntimeArgs(["--unknown", "x"])).toThrow("Unknown argument");
    expect(() => parseRuntimeArgs(["--status=true"])).toThrow("does not accept a value");
    expect(() => parseRuntimeArgs(["--backup", "/tmp/a", "--restore", "/tmp/b"])).toThrow(
      "only one of --backup and --restore",
    );
    expect(() => parseRuntimeArgs(["--update", "--status"])).toThrow(
      "only when starting the runtime",
    );
  });
});
