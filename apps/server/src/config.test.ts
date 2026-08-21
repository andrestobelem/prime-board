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

  it("keeps API-key mode as the default", () => {
    const config = loadConfig({});
    expect(config.authMode).toBe("api-key");
    expect(config.host).toBe("0.0.0.0");
  });

  it("rejects unknown authentication modes", () => {
    expect(() => loadConfig({ PRIME_BOARD_AUTH_MODE: "shared" })).toThrow(
      "Invalid PRIME_BOARD_AUTH_MODE",
    );
  });
});
