// Tests de AT-133: teams con workflow default, actores agente y API keys por GraphQL.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("teams", () => {
  it("crea un team y siembra el workflow default", async () => {
    const result = await gql(
      app,
      `
      mutation {
        teamCreate(input: { name: "Agents", key: "ag" }) {
          success
          team { key name states { name type } }
        }
      }
    `,
    );
    expect(result.errors).toBeUndefined();
    const team = result.data!.teamCreate.team;
    expect(team.key).toBe("AG");
    expect(team.states.map((s: any) => s.type)).toEqual([
      "BACKLOG",
      "UNSTARTED",
      "STARTED",
      "COMPLETED",
      "CANCELED",
    ]);
    const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    const teamRow = app.db.query("SELECT id, workspace_id FROM teams WHERE key = 'AG'").get() as {
      id: string;
      workspace_id: string;
    };
    expect(teamRow.workspace_id).toBe(workspace.id);
    expect(
      app.db
        .query(
          "SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1 AND workspace_id = ?2",
        )
        .get(teamRow.id, workspace.id),
    ).toEqual({ count: 5 });
    expect(
      app.db.query("SELECT count(*) AS count FROM cycles WHERE team_id = ?1").get(teamRow.id),
    ).toEqual({ count: 3 });
  });

  it("busca team por key y agrega estados custom", async () => {
    const found = await gql(app, `{ team(key: "AG") { id name } }`);
    expect(found.data!.team.name).toBe("Agents");

    const state = await gql(
      app,
      `
      mutation($teamId: ID!) {
        workflowStateCreate(input: { teamId: $teamId, name: "Ready for Agent", type: UNSTARTED }) {
          workflowState { name type position }
        }
      }
    `,
      { teamId: found.data!.team.id },
    );
    expect(state.data!.workflowStateCreate.workflowState).toMatchObject({
      name: "Ready for Agent",
      type: "UNSTARTED",
    });
  });

  it("rechaza keys de team inválidas o duplicadas", async () => {
    const bad = await gql(
      app,
      `mutation { teamCreate(input: { name: "X", key: "123!" }) { success } }`,
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const dup = await gql(
      app,
      `mutation { teamCreate(input: { name: "X", key: "AG" }) { success } }`,
    );
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("crea el horizonte de Cycles configurado solo cuando está habilitado", async () => {
    const configured = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Cycle horizon", key: "HZN", cyclesEnabled: true,
          timezone: "America/New_York", cycleStartDay: WEDNESDAY,
          cycleDurationWeeks: 1, cycleCooldownDays: 2, cycleUpcomingCount: 5
        }) { team { id cycleUpcomingCount } }
      }`,
    );
    expect(configured.errors).toBeUndefined();
    const configuredTeam = configured.data!.teamCreate.team;
    expect(configuredTeam.cycleUpcomingCount).toBe(5);

    const cycles = await gql(
      app,
      `query($teamId: ID!) {
        cycles(teamId: $teamId) { number name state cadenceSource startsAt endsAt }
      }`,
      { teamId: configuredTeam.id },
    );
    expect(cycles.errors).toBeUndefined();
    expect(cycles.data!.cycles).toHaveLength(5);
    expect(cycles.data!.cycles).toEqual(
      expect.arrayContaining(
        Array.from({ length: 5 }, (_, index) =>
          expect.objectContaining({
            number: index + 1,
            name: `Cycle ${index + 1}`,
            state: "UPCOMING",
            cadenceSource: "CADENCE",
          }),
        ),
      ),
    );
    const localParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(cycles.data!.cycles[0].startsAt));
    expect(localParts.find((part) => part.type === "weekday")?.value).toBe("Wednesday");
    expect(localParts.find((part) => part.type === "hour")?.value).toBe("00");
    expect(localParts.find((part) => part.type === "minute")?.value).toBe("00");

    const disabled = await gql(
      app,
      `mutation { teamCreate(input: { name: "Disabled cycles", key: "NOC", cyclesEnabled: false }) {
        team { id }
      } }`,
    );
    expect(disabled.errors).toBeUndefined();
    const disabledCycles = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id } }`,
      { teamId: disabled.data!.teamCreate.team.id },
    );
    expect(disabledCycles.data!.cycles).toEqual([]);

    const zero = await gql(
      app,
      `mutation { teamCreate(input: {
        name: "Zero cycles", key: "ZER", cyclesEnabled: true, cycleUpcomingCount: 0
      }) { team { id } } }`,
    );
    expect(zero.errors).toBeUndefined();
    const zeroCycles = await gql(app, `query($teamId: ID!) { cycles(teamId: $teamId) { id } }`, {
      teamId: zero.data!.teamCreate.team.id,
    });
    expect(zeroCycles.data!.cycles).toEqual([]);
  });
  it("revierte Team y workflow si falla la creación del horizonte", async () => {
    const isolated = createTestApp();
    try {
      isolated.db.exec(`
        CREATE TRIGGER fail_cycle_horizon
        BEFORE INSERT ON cycles
        BEGIN
          SELECT RAISE(ABORT, 'cycle horizon failure');
        END;
      `);
      const failed = await gql(
        isolated,
        `mutation { teamCreate(input: { name: "Atomic horizon", key: "ATOM" }) { success } }`,
      );
      expect(failed.errors).toBeDefined();
      expect(isolated.db.query("SELECT id FROM teams WHERE key = 'ATOM'").get()).toBeNull();
      expect(
        isolated.db
          .query(
            "SELECT count(*) AS count FROM workflow_states WHERE team_id IN (SELECT id FROM teams WHERE key = 'ATOM')",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        isolated.db
          .query(
            "SELECT count(*) AS count FROM cycles WHERE team_id IN (SELECT id FROM teams WHERE key = 'ATOM')",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      isolated.stop();
    }
  });
});

describe("actores y API keys", () => {
  it("da de alta un agente con su key y el agente opera como viewer", async () => {
    const created = await gql(
      app,
      `
      mutation {
        actorCreate(input: { name: "prime-agent", type: AGENT }) {
          actor { id name type }
        }
      }
    `,
    );
    const agent = created.data!.actorCreate.actor;
    expect(agent.type).toBe("AGENT");

    const keyResult = await gql(
      app,
      `
      mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "agent key" }) {
          key
          apiKey { name actor { name } }
        }
      }
    `,
      { actorId: agent.id },
    );
    const plaintext = keyResult.data!.apiKeyCreate.key;
    expect(plaintext).toStartWith("pb_");

    // Round-trip: el agente usa su propia key.
    const asAgent = await gql(app, "{ viewer { name type } }", {}, plaintext);
    expect(asAgent.data!.viewer).toEqual({ name: "prime-agent", type: "AGENT" });
  });

  it("permite cambiar el nombre de un agente sin perder su identidad", async () => {
    const created = await gql(
      app,
      `
      mutation { actorCreate(input: { name: "renameable-agent", type: AGENT }) { actor { id name } } }
    `,
    );
    const actorId = created.data!.actorCreate.actor.id;
    const updated = await gql(
      app,
      `
      mutation($id: ID!) { actorUpdate(id: $id, input: { name: "planner", email: "planner@example.com" }) { actor { id name email type } } }
    `,
      { id: actorId },
    );

    expect(updated.errors).toBeUndefined();
    expect(updated.data!.actorUpdate.actor).toEqual({
      id: actorId,
      name: "planner",
      email: "planner@example.com",
      type: "AGENT",
    });

    const duplicate = await gql(
      app,
      `
      mutation($id: ID!) { actorUpdate(id: $id, input: { name: "admin" }) { success } }
    `,
      { id: actorId },
    );
    expect(duplicate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const duplicateCreate = await gql(
      app,
      `
      mutation { actorCreate(input: { name: "ADMIN", type: AGENT }) { success } }
    `,
    );
    expect(duplicateCreate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("no reactiva nombres históricos de agentes retirados", async () => {
    const createHistorical = await gql(
      app,
      `mutation { actorCreate(input: { name: "claude", type: AGENT }) { success } }`,
    );
    expect(createHistorical.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const created = await gql(
      app,
      `mutation { actorCreate(input: { name: "fresh-agent", type: AGENT }) { actor { id } } }`,
    );
    const renameToHistorical = await gql(
      app,
      `
      mutation($id: ID!) {
        actorUpdate(id: $id, input: { name: "demo-agent" }) { success }
      }
    `,
      { id: created.data!.actorCreate.actor.id },
    );
    expect(renameToHistorical.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("tras renombrar, las API keys existentes siguen autenticando al mismo actor", async () => {
    const created = await gql(
      app,
      `
      mutation { actorCreate(input: { name: "keyed-agent", type: AGENT }) { actor { id } } }
    `,
    );
    const actorId = created.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `
      mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "stable key" }) { key }
      }
    `,
      { actorId },
    );
    const plaintext = keyResult.data!.apiKeyCreate.key;

    await gql(
      app,
      `
      mutation($id: ID!) {
        actorUpdate(id: $id, input: { name: "keyed-renamed", email: "keyed@example.com" }) {
          actor { id name }
        }
      }
    `,
      { id: actorId },
    );

    const asAgent = await gql(app, "{ viewer { id name email type } }", {}, plaintext);
    expect(asAgent.errors).toBeUndefined();
    expect(asAgent.data!.viewer).toEqual({
      id: actorId,
      name: "keyed-renamed",
      email: "keyed@example.com",
      type: "AGENT",
    });

    const keys = await gql(app, `{ actors { id apiKeys { id name } } }`);
    const actor = keys.data!.actors.find((a: { id: string }) => a.id === actorId);
    expect(actor.apiKeys.map((k: { name: string }) => k.name)).toEqual(["stable key"]);
  });

  it("apiKeyCreate falla con actor inexistente", async () => {
    const result = await gql(
      app,
      `
      mutation { apiKeyCreate(input: { actorId: "nope", name: "x" }) { key } }
    `,
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("lista actores filtrando por tipo", async () => {
    const result = await gql(app, `{ actors(type: AGENT) { name type } }`);
    expect(result.data!.actors).toEqual([
      { name: "prime-agent", type: "AGENT" },
      { name: "planner", type: "AGENT" },
      { name: "fresh-agent", type: "AGENT" },
      { name: "keyed-renamed", type: "AGENT" },
    ]);
  });
});
