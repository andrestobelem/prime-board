import { describe, expect, it } from "bun:test";
import { createRequestGate } from "../src/request-generation.ts";

describe("request generation", () => {
  it("accepts only the newest response when promises resolve out of order", () => {
    const gate = createRequestGate();
    const oldRequest = gate.next();
    const currentRequest = gate.next();

    expect(gate.isCurrent(currentRequest)).toBe(true);
    expect(gate.isCurrent(oldRequest)).toBe(false);
  });
});
