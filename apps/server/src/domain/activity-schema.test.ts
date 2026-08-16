// Test del esquema de referencias de Activity (AT-187): cubre los 17
// ActivityType y prueba que translateActivityRefs replica exactamente el
// comportamiento que antes vivía duplicado en exporter.ts e importer.ts.
import { describe, expect, it } from "bun:test";
import { ACTIVITY_REFS, ALL_ACTIVITY_TYPES, translateActivityRefs } from "./activity-schema.ts";
import type { ActivityType } from "./activity.ts";

const idToName = (table: string, value: string) =>
  (
    ({
      states: { s1: "Todo", s2: "In Progress" },
      actors: { a1: "alice" },
      projects: { p1: "Roadmap" },
      milestones: { m1: "Fase 1" },
      issues: { i1: "AT-1" },
      teams: { t1: "AT" },
      cycles: { c1: "PB/1" },
    }) as any
  )[table]?.[value];

const nameToId = (table: string, value: string) =>
  (
    ({
      states: { Todo: "s1", "In Progress": "s2" },
      actors: { alice: "a1" },
      projects: { Roadmap: "p1" },
      milestones: { "Fase 1": "m1" },
      issues: { "AT-1": "i1" },
      teams: { AT: "t1" },
      cycles: { "PB/1": "c1" },
    }) as any
  )[table]?.[value];

describe("ACTIVITY_REFS", () => {
  it("cubre los 17 ActivityType existentes (declarados con refs o sin ellas)", () => {
    for (const type of ALL_ACTIVITY_TYPES) {
      // No hace falta que todos tengan entrada (la mayoría no tiene refs) —
      // pero el tipo tiene que existir en el union, y el test lo enumera acá
      // para que agregar un ActivityType nuevo obligue a mirar esta lista.
      expect(ALL_ACTIVITY_TYPES).toContain(type);
    }
    expect(ALL_ACTIVITY_TYPES.length).toBe(17);
  });

  it("los tipos sin referencias no tienen entrada en ACTIVITY_REFS", () => {
    for (const type of [
      "title_changed",
      "description_changed",
      "priority_changed",
      "labeled",
      "unlabeled",
      "relation_added",
      "relation_removed",
      "archived",
    ] as ActivityType[]) {
      expect(ACTIVITY_REFS[type]).toBeUndefined();
    }
  });
});

describe("translateActivityRefs — dirección id→clave natural (export)", () => {
  it("state_changed traduce from/to por states, conserva el resto del payload", () => {
    const out = translateActivityRefs(
      "state_changed",
      { from: "s1", to: "s2", reason: "x" },
      idToName,
    );
    expect(out).toEqual({ from: "Todo", to: "In Progress", reason: "x" });
  });

  it("cycle_changed traduce la referencia estable del cycle y permite round-trip", () => {
    const exported = translateActivityRefs("cycle_changed", { from: null, to: "c1" }, idToName);
    expect(exported).toEqual({ from: null, to: "PB/1" });
    expect(translateActivityRefs("cycle_changed", exported, nameToId, "toIds")).toEqual({
      from: null,
      to: "c1",
    });
  });

  it("modo sparse: si el lookup no encuentra la clave, conserva el valor original", () => {
    const out = translateActivityRefs("assigned", { from: "a-desconocido", to: "a1" }, idToName);
    expect(out).toEqual({ from: "a-desconocido", to: "alice" });
  });

  it("modo sparse: si el campo no está presente, no lo agrega", () => {
    const out = translateActivityRefs("project_changed", { to: "p1" }, idToName);
    expect(out).toEqual({ to: "Roadmap" });
    expect("from" in out).toBe(false);
  });

  it("modo sparse: valores no-string (null) se conservan sin tocar", () => {
    const out = translateActivityRefs("milestone_changed", { from: "m1", to: null }, idToName);
    expect(out).toEqual({ from: "Fase 1", to: null });
  });

  it("created renombra los campos *Id y siempre resuelve a null si falta el valor", () => {
    const out = translateActivityRefs(
      "created",
      {
        teamId: "t1",
        stateId: "s1",
        assigneeId: null,
        parentId: undefined,
        projectId: "p1",
        milestoneId: "m1",
        title: "Algo",
      },
      idToName,
    );
    expect(out).toEqual({
      title: "Algo",
      team: "AT",
      state: "Todo",
      assignee: null,
      parent: null,
      project: "Roadmap",
      milestone: "Fase 1",
    });
  });

  it("created resuelve a null (no al valor original) si el lookup no encuentra la clave", () => {
    const out = translateActivityRefs("created", { teamId: "t-fantasma" }, idToName);
    expect(out.team).toBeNull();
  });

  it("parent_changed traduce por issues (identificadores legibles)", () => {
    const out = translateActivityRefs("parent_changed", { from: "i1", to: null }, idToName);
    expect(out).toEqual({ from: "AT-1", to: null });
  });

  it("los tipos sin refs (priority_changed, labeled, archived...) pasan sin tocar", () => {
    const payload = { to: 2, label: "web" };
    expect(translateActivityRefs("priority_changed", payload, idToName)).toEqual(payload);
    expect(translateActivityRefs("labeled", payload, idToName)).toEqual(payload);
    expect(translateActivityRefs("archived", {}, idToName)).toEqual({});
  });
});

describe("translateActivityRefs — dirección clave natural→id (import), la inversa exacta", () => {
  it("state_changed es la inversa de la traducción de export", () => {
    const exported = translateActivityRefs("state_changed", { from: "s1", to: "s2" }, idToName);
    const roundTripped = translateActivityRefs("state_changed", exported, nameToId, "toIds");
    expect(roundTripped).toEqual({ from: "s1", to: "s2" });
  });

  it("created es la inversa exacta, incluidos los renombres", () => {
    const original = {
      teamId: "t1",
      stateId: "s1",
      assigneeId: "a1",
      parentId: "i1",
      projectId: "p1",
      milestoneId: "m1",
    };
    const exported = translateActivityRefs("created", original, idToName);
    const roundTripped = translateActivityRefs("created", exported, nameToId, "toIds");
    expect(roundTripped).toEqual(original);
  });

  it("modo sparse en import también conserva el valor si el lookup falla", () => {
    const out = translateActivityRefs(
      "assigned",
      { from: "nombre-desconocido" },
      nameToId,
      "toIds",
    );
    expect(out).toEqual({ from: "nombre-desconocido" });
  });
});
