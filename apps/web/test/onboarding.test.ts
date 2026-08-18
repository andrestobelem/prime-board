import { describe, expect, test } from "bun:test";
import {
  getOnboardingKeyFromSearch,
  shouldUseOnboardingKey,
  stripOnboardingKey,
} from "../src/onboarding.ts";

describe("API key onboarding links", () => {
  test("reads an encoded key and preserves unrelated query parameters", () => {
    expect(getOnboardingKeyFromSearch("?next=%2Fsettings&key=pb_invited%2Bkey")).toBe(
      "pb_invited+key",
    );
    expect(stripOnboardingKey("?next=%2Fsettings&key=pb_invited%2Bkey")).toBe("?next=%2Fsettings");
  });

  test("strips the onboarding key when it is the only parameter", () => {
    expect(stripOnboardingKey("?key=pb_invited")).toBe("");
    expect(stripOnboardingKey("?key=")).toBe("");
  });

  test("keeps an existing credential until the user explicitly chooses the invite key", () => {
    expect(shouldUseOnboardingKey("", "pb_invited")).toBe(true);
    expect(shouldUseOnboardingKey("pb_existing", "pb_invited")).toBe(false);
    expect(shouldUseOnboardingKey("pb_same", "pb_same")).toBe(false);
  });
});
