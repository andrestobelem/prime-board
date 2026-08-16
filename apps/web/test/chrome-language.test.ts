import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

const chromeSources = [
  "src/App.tsx",
  "src/components/IssueList.tsx",
  "src/views/BoardView.tsx",
  "src/views/ProjectView.tsx",
].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("frontend chrome language", () => {
  it("keeps the visible list and board chrome in English", () => {
    const source = chromeSources.join("\n");
    for (const spanishChrome of [
      "Agrupar por",
      "Sin milestone",
      "Sin assignee",
      "Sin prioridad",
      "Estados y labels",
    ]) {
      expect(source).not.toContain(spanishChrome);
    }
  });
});
