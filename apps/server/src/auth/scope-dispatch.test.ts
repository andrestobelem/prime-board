import { describe, expect, it } from "bun:test";
import { POSTGRES_SUPPORTED_OPERATIONS } from "./scope-dispatch.ts";

describe("PostgreSQL operation dispatch", () => {
  it("keeps cycleCreateFromCadence in the migrated mutation allowlist", () => {
    expect(POSTGRES_SUPPORTED_OPERATIONS.has("mutation:cycleCreateFromCadence")).toBe(true);
  });
});
