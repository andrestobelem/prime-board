import { describe, expect, it } from "bun:test";
import { buildNavigation, getDefaultTeamPath, getTeamKeyForRoute } from "../src/navigation.ts";

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

describe("contexto de team para Quick Create", () => {
  const routeTeams = [
    {
      key: "ONE",
      projects: [{ id: "shared" }],
      cycles: [{ id: "cycle-one" }],
    },
    {
      key: "TWO",
      projects: [{ id: "two-project" }],
      cycles: [{ id: "cycle-two" }],
    },
  ];

  it("conserva el team en rutas de team, triage y settings", () => {
    expect(getTeamKeyForRoute(["triage", "TWO"], routeTeams)).toBe("TWO");
    expect(getTeamKeyForRoute(["team-settings", "TWO"], routeTeams)).toBe("TWO");
    expect(getTeamKeyForRoute(["team", "TWO", "home"], routeTeams)).toBe("TWO");
  });

  it("resuelve el team desde issue, cycle y project", () => {
    expect(getTeamKeyForRoute(["issue", "TWO-42"], routeTeams)).toBe("TWO");
    expect(getTeamKeyForRoute(["cycle", "cycle-two"], routeTeams)).toBe("TWO");
    expect(getTeamKeyForRoute(["project", "two-project"], routeTeams)).toBe("TWO");
  });

  it("usa el primer team solo cuando la ruta no aporta contexto", () => {
    expect(getTeamKeyForRoute(["inbox"], routeTeams)).toBe("ONE");
    expect(getTeamKeyForRoute(["project", "missing"], routeTeams)).toBe("ONE");
  });

  it("abre el board como vista predeterminada del team", () => {
    expect(getDefaultTeamPath("TWO")).toBe("/board/TWO");
  });
});
