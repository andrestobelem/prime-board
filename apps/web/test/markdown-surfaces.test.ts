import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

describe("Markdown rendering surfaces", () => {
  test("uses the shared renderer for initiative and project descriptions", () => {
    const initiative = source("views/InitiativeView.tsx");
    const project = source("views/ProjectView.tsx");

    expect(initiative).toContain("MarkdownContent");
    expect(initiative).toContain('className="markdown initiative-description"');
    expect(initiative).not.toContain(">\n          {initiative.description}\n");
    expect(project).toContain("MarkdownContent");
    expect(project).toContain('className="markdown project-description"');
    expect(project).not.toContain(">\n            {project.description}\n");
  });

  test("renders project updates and risks through MarkdownContent", () => {
    const project = source("views/ProjectView.tsx");

    expect(project).toContain("text={update.body}");
    expect(project).toContain("text={update.risks}");
    expect(project).toContain('className="project-update-risks"');
  });
});
