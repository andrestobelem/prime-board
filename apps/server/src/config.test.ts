import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config.ts";

describe("server config", () => {
  it("forces loopback when local auth is enabled", () => {
    const config = loadConfig({
      PRIME_BOARD_AUTH_MODE: "local",
      PRIME_BOARD_HOST: "0.0.0.0",
    });
    expect(config.authMode).toBe("local");
    expect(config.host).toBe("127.0.0.1");
  });

  it("keeps API-key mode on loopback by default", () => {
    const config = loadConfig({});
    expect(config.authMode).toBe("api-key");
    expect(config.host).toBe("127.0.0.1");
  });

  it("requires an explicit host override for a non-loopback API-key bind", () => {
    const config = loadConfig({
      PRIME_BOARD_HOST: "0.0.0.0",
    });
    expect(config.host).toBe("0.0.0.0");
  });

  it("rejects unknown authentication modes", () => {
    expect(() => loadConfig({ PRIME_BOARD_AUTH_MODE: "shared" })).toThrow(
      "Invalid PRIME_BOARD_AUTH_MODE",
    );
  });

  it("rejects host values that are not hostnames or addresses", () => {
    expect(() => loadConfig({ PRIME_BOARD_HOST: "http://0.0.0.0" })).toThrow(
      "Invalid PRIME_BOARD_HOST",
    );
  });

  it("loads the initial Workspace and Team identity from environment variables", () => {
    const config = loadConfig({
      PRIME_BOARD_WORKSPACE_NAME: "  Agents  ",
      PRIME_BOARD_WORKSPACE_URL_KEY: "agents-workspace",
      PRIME_BOARD_TEAM_NAME: "  Runtime  ",
      PRIME_BOARD_TEAM_KEY: " rt ",
    });
    expect(config.bootstrap).toEqual({
      workspaceName: "Agents",
      workspaceUrlKey: "agents-workspace",
      teamName: "Runtime",
      teamKey: "RT",
    });
  });
});
