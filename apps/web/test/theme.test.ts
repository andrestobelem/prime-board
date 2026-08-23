import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isThemePreference,
  resolveTheme,
  THEME_OPTIONS,
  type ResolvedTheme,
} from "../src/theme.ts";

describe("theme preferences", () => {
  it("recognizes Catppuccin flavors and legacy preferences", () => {
    const values = THEME_OPTIONS.map((option) => option.value);
    expect(values).toEqual([
      "system",
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
      "dark",
      "light",
    ]);
    for (const value of values) expect(isThemePreference(value)).toBe(true);
    expect(isThemePreference("unknown")).toBe(false);
  });

  it("resolves System to the light or dark Catppuccin flavor", () => {
    expect(resolveTheme("system", false)).toBe("catppuccin-latte");
    expect(resolveTheme("system", true)).toBe("catppuccin-mocha");
  });

  it("does not change an explicit flavor", () => {
    const flavors: ResolvedTheme[] = [
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
    ];
    for (const flavor of flavors) expect(resolveTheme(flavor, true)).toBe(flavor);
  });

  it("keeps the inline FOUC guard in sync with all theme ids", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    for (const option of THEME_OPTIONS) expect(html).toContain(option.value);
    expect(html).toContain('preference === "system" ? systemTheme : preference');
  });
});
