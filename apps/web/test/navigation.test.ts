import { describe, expect, it } from "bun:test";
import { buildNavigation } from "../src/navigation.ts";

const teams = [
  { id: "one", projects: [{ id: "shared", name: "Shared", state: "started" }] },
  {
    id: "two",
    projects: [
      { id: "shared", name: "Shared", state: "started" },
      { id: "two-project", name: "Two", state: "backlog" },
    ],
  },
];
const views = [
  { id: "workspace", name: "All", scope: "workspace", team: null },
  { id: "personal", name: "Mine", scope: "personal", team: null },
  { id: "one-view", name: "One", scope: "team", team: { id: "one", key: "ONE" } },
  { id: "two-view", name: "Two", scope: "TEAM", team: { id: "two", key: "TWO" } },
];

describe("navegación por scope", () => {
  it("separa vistas workspace/personales de las team-scoped", () => {
    const model = buildNavigation(teams, views);
    expect(model.workspaceViews.map((view) => view.id)).toEqual(["workspace", "personal"]);
    expect(model.teams[0]!.views.map((view) => view.id)).toEqual(["one-view"]);
    expect(model.teams[1]!.views.map((view) => view.id)).toEqual(["two-view"]);
  });

  it("deduplica el índice global sin perder la asociación por team", () => {
    const model = buildNavigation(teams, views);
    expect(model.projects.map((project) => project.id)).toEqual(["shared", "two-project"]);
    expect(model.teams.map((team) => team.projects.map((project) => project.id))).toEqual([
      ["shared"],
      ["shared", "two-project"],
    ]);
  });
});
