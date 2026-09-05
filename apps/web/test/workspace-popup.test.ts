import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");

const rule = (selector: string) => {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = styles.indexOf("\n}", start);
  return end < 0 ? "" : styles.slice(start + selector.length + 2, end);
};

describe("Workspace selector popup layout", () => {
  test("keeps the popup outside the scrolling overflow container", () => {
    const sidebarRule = rule(".sidebar");
    const scrollRule = rule(".sidebar-scroll");
    const menuIndex = sidebar.indexOf('<div className="workspace-menu">');
    const scrollIndex = sidebar.indexOf('<div className="sidebar-scroll">');

    expect(sidebarRule).not.toContain("overflow-x: hidden;");
    expect(sidebarRule).not.toContain("overflow-y: auto;");
    expect(scrollRule).toContain("overflow-x: hidden;");
    expect(scrollRule).toContain("overflow-y: auto;");
    expect(menuIndex).toBeGreaterThan(-1);
    expect(scrollIndex).toBeGreaterThan(menuIndex);
  });

  test("limits popup height and truncates long Workspace references", () => {
    const popupRule = rule(".workspace-menu-popup");
    const urlKeyRule = rule(".sidebar .workspace-url-key");

    expect(popupRule).toContain("max-height:");
    expect(popupRule).toContain("overflow-y: auto;");
    expect(urlKeyRule).toContain("min-width: 0;");
    expect(urlKeyRule).toContain("overflow: hidden;");
    expect(urlKeyRule).toContain("text-overflow: ellipsis;");
    expect(urlKeyRule).toContain("white-space: nowrap;");
  });
});
