import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("issue layout typography", () => {
  test("keeps issue identifiers on one line and titles flexible", () => {
    const identifier = styles.match(/\.issue-row \.identifier \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const title = styles.match(/\.issue-row \.title \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(identifier).toContain("width: 64px;");
    expect(identifier).toContain("white-space: nowrap;");
    expect(title).toContain("min-width: 0;");
    expect(title).toContain("flex: 1 1 auto;");
  });

  test("keeps the detail hierarchy explicit at the larger scale", () => {
    expect(styles).toContain(".markdown h2 {");
    expect(styles).toContain("font-size: 22px;");
    expect(styles).toContain(".markdown h3 {");
    expect(styles).toContain("font-size: 18px;");
    expect(styles).toContain(".issue-props .prop > span {");
    expect(styles).toContain("font-size: 12px;");
  });
});
