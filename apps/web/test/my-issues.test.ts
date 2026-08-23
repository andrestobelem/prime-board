import { describe, expect, it } from "bun:test";
import { buildMyIssuesOwnerFilter, getMyIssuesScopeCopy } from "../src/my-issues.ts";

describe("Alcance de My issues", () => {
  it("filtra las Issues asignadas al Actor autenticado", () => {
    expect(buildMyIssuesOwnerFilter("actor-1", "assigned")).toEqual({
      assignee: { eq: "actor-1" },
    });
  });

  it("filtra las Issues creadas por el Actor autenticado", () => {
    expect(buildMyIssuesOwnerFilter("actor-1", "created")).toEqual({
      creator: { eq: "actor-1" },
    });
  });

  it("usa semántica de asignación o autoría sin simular suscripciones", () => {
    const filter = buildMyIssuesOwnerFilter("actor-1", "handoff");

    expect(filter).toEqual({
      or: [{ assignee: { eq: "actor-1" } }, { creator: { eq: "actor-1" } }],
    });
    expect(JSON.stringify(filter)).not.toContain("subscriber");
  });

  it("no consulta Issues antes de obtener la identidad del viewer", () => {
    expect(buildMyIssuesOwnerFilter(undefined, "handoff")).toEqual({ search: "__pending__" });
  });

  it("explica el alcance efectivo cuando la cola está vacía", () => {
    expect(getMyIssuesScopeCopy("handoff", "Ada")).toEqual({
      description: "Issues assigned to or created by Ada",
      emptyState: "No issues assigned to or created by Ada.",
    });
  });
});
