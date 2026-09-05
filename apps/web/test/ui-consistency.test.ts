import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const designSystem = readFileSync(
  new URL("../../../docs/design-system.md", import.meta.url),
  "utf8",
);
const componentSources = [
  "../src/App.tsx",
  "../src/components/Sidebar.tsx",
  "../src/components/IssueActions.tsx",
  "../src/views/IssueView.tsx",
  "../src/views/ProjectView.tsx",
  "../src/views/TeamSettingsView.tsx",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

describe("UI consistency tokens", () => {
  test("uses shared tokens for every component radius and shadow", () => {
    expect(styles).toContain("--radius-sm: 4px;");
    expect(styles).toContain("--radius-md: 8px;");
    expect(styles).toContain("--radius-lg: 10px;");
    expect(styles).toContain("--shadow-popup:");
    expect(styles).toContain("--shadow-popover:");
    expect(styles).toContain("--shadow-modal:");
    expect(styles).toContain("--shadow-drawer:");

    const radiusValues = [...styles.matchAll(/border-radius:\s*([^;]+)/g)].map(([, value]) =>
      value?.trim(),
    );
    const shadowValues = [...styles.matchAll(/box-shadow:\s*([^;]+)/g)].map(([, value]) =>
      value?.trim(),
    );
    expect(radiusValues.every((value) => value?.startsWith("var("))).toBe(true);
    expect(shadowValues.every((value) => value?.startsWith("var("))).toBe(true);
  });

  test("keeps navigation count text on the accent contrast color", () => {
    const navCount = styles.match(/\.sidebar \.nav-count \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(navCount).toContain("color: var(--accent-contrast);");
    expect(navCount).toContain("border-radius: var(--radius-lg);");
  });
});

describe("icon buttons and keyboard focus", () => {
  test("has one icon-button class with a mobile touch target", () => {
    for (const source of componentSources) {
      expect(source).not.toContain("favorite-action");
      expect(source).not.toContain("issue-icon-button");
      expect(source).not.toContain("icon-action");
    }
    expect(styles).toContain(".icon-button {");
    expect(styles).toContain("width: 28px;");
    expect(styles).toContain("height: 28px;");
    expect(styles).toContain("width: 44px;");
    expect(styles).toContain("height: 44px;");
  });

  test("keeps the keyboard focus ring visible on form controls", () => {
    expect(styles).toContain("input:focus-visible,");
    expect(styles).toContain("textarea:focus-visible,");
    expect(styles).toContain("select:focus-visible,");
    expect(styles).toContain("button:focus-visible {");
    expect(styles).not.toContain("outline: none");
  });

  test("uses the shared class for sidebar icon-only create controls", () => {
    const sidebar = componentSources[1] ?? "";
    const createActionButtons =
      sidebar.match(/<button[\s\S]*?<Icon name="plus" size=\{12\} \/>[\s\S]*?<\/button>/g) ?? [];

    expect(createActionButtons).toHaveLength(4);
    expect(createActionButtons.every((button) => button.includes('className="icon-button"'))).toBe(
      true,
    );
  });

  test("uses the shared class for icon-only relation actions", () => {
    const issueView = componentSources[3] ?? "";
    const removeRelationButtons =
      issueView.match(/<button[\s\S]*?aria-label="Remove relation"[\s\S]*?<\/button>/g) ?? [];

    expect(removeRelationButtons).toHaveLength(1);
    expect(removeRelationButtons[0]).toContain('className="icon-button"');
  });

  test("contains sidebar overflow and keeps resource labels truncatable", () => {
    const sidebarRule = styles.match(/\.sidebar \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const sidebarScrollRule = styles.match(/\.sidebar-scroll \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const sidebar = componentSources[1] ?? "";

    expect(sidebarRule).toContain("overflow: visible;");
    expect(sidebarScrollRule).toContain("overflow-x: hidden;");
    expect(sidebarScrollRule).toContain("overflow-y: auto;");
    expect(sidebar).toContain('className="resource-label">{project.name}</span>');
    expect(sidebar).toContain('className="resource-label">{view.name}</span>');
    expect(sidebar).toContain('className="resource-label">{initiative.name}</span>');
    expect(sidebar).toContain('className="resource-label">{cycle.name}</span>');
    expect(sidebar).toContain('className="resource-label">{name}</span>');
  });
});

describe("design-system documentation", () => {
  test("records the PRB-565 density and icon-button decisions", () => {
    expect(designSystem).toContain("Decisiones técnicas de PRB-565");
    expect(designSystem).toContain("`.icon-button` es la única clase del rol");
    expect(designSystem).toContain("64px, una línea y truncado");
    expect(designSystem).toContain("--accent-contrast");
  });
});
