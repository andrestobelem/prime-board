/**
 * Smoke GraphQL del dominio Workspace/Actors contra PostgreSQL.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-actors.ts
 */
import { openDatabase } from "../apps/server/src/db/database.ts";
import { generateApiKey, hashApiKey } from "../apps/server/src/auth/keys.ts";
import { newId, now } from "../apps/server/src/db/util.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { migratePostgres } from "../apps/server/src/db/postgres/migrator.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const sql = new Bun.SQL({ url, max: 10, connectionTimeout: 5 });
const db = openDatabase(":memory:");
let persistence: ReturnType<typeof createPostgresPersistence> | undefined;
let server: ReturnType<typeof createApp>["server"] | undefined;
const report: Record<string, unknown> = {};
const config: Config = {
  port: 0,
  dbPath: ":memory:",
  postgresUrl: url,
  persistenceBackend: "postgres",
  dev: false,
  webDist: "/tmp/prime-board-no-web",
  repoRoot: null,
};

async function graphql(
  base: string,
  query: string,
  variables?: Record<string, unknown>,
  token = adminKey,
) {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: any;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
}

let adminKey = "";
try {
  await migratePostgres(sql);
  persistence = createPostgresPersistence(sql);
  const seeded = await bootstrapPostgres(persistence);
  adminKey = seeded.adminApiKey ?? "";
  if (!adminKey) throw new Error("Validation requires a fresh PostgreSQL database");
  const app = createApp({ db, config, persistence });
  server = app.server;
  const base = `http://127.0.0.1:${server.port}`;

  const before = await graphql(
    base,
    `
      {
        workspace {
          id
          name
          urlKey
        }
        actors {
          id
          name
          status
        }
      }
    `,
  );
  const workspaceId = before.data?.workspace.id;
  const created = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
            name
            status
            type
          }
        }
      }
    `,
    { input: { name: "Postgres Agent", type: "AGENT" } },
  );
  const actorId = created.data?.actorCreate.actor.id;
  const member = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
            name
          }
        }
      }
    `,
    { input: { name: "Postgres Member", type: "HUMAN" } },
  );
  const memberId = member.data?.actorCreate.actor.id;
  const memberKey = generateApiKey();
  const memberKeyId = newId();
  await persistence.execute(
    `INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [memberKeyId, memberId, "member validation key", hashApiKey(memberKey), now()],
  );
  for (const scope of ["read", "write"]) {
    await persistence.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
      memberKeyId,
      scope,
    ]);
  }
  const memberViewer = await graphql(
    base,
    `
      {
        viewer {
          id
          status
        }
      }
    `,
    undefined,
    memberKey,
  );
  const memberDenied = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
          }
        }
      }
    `,
    { input: { name: "Denied Agent", type: "AGENT" } },
    memberKey,
  );
  const adminId = before.data?.actors.find((actor: { name: string }) => actor.name === "admin")?.id;
  const teamId = (await persistence.one<{ id: string }>("SELECT id FROM teams LIMIT 1"))?.id;
  const expiredKey = generateApiKey();
  await persistence.execute(
    `INSERT INTO api_keys (id, actor_id, name, hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      adminId,
      "expired validation key",
      hashApiKey(expiredKey),
      now(),
      new Date(Date.now() - 1000).toISOString(),
    ],
  );
  const expiredViewer = await graphql(
    base,
    `
      {
        viewer {
          id
        }
      }
    `,
    undefined,
    expiredKey,
  );
  const keyCreated = await graphql(
    base,
    `
      mutation ($input: ApiKeyCreateInput!) {
        apiKeyCreate(input: $input) {
          success
          apiKey {
            id
            scopes
            teamIds
          }
          key
        }
      }
    `,
    {
      input: {
        actorId: adminId,
        name: "rotation validation",
        scopes: ["READ", "WRITE"],
        teamIds: [teamId],
      },
    },
  );
  const issuedKey = keyCreated.data?.apiKeyCreate.key;
  const issuedKeyId = keyCreated.data?.apiKeyCreate.apiKey.id;
  const issuedViewer = await graphql(
    base,
    `
      {
        viewer {
          id
        }
      }
    `,
    undefined,
    issuedKey,
  );
  const rotatedKey = await graphql(
    base,
    `
      mutation ($id: ID!, $input: ApiKeyRotateInput!) {
        apiKeyRotate(id: $id, input: $input) {
          success
          apiKey {
            id
            scopes
            teamIds
          }
          key
        }
      }
    `,
    { id: issuedKeyId, input: { name: "rotated validation" } },
    issuedKey,
  );
  const replacementKey = rotatedKey.data?.apiKeyRotate.key;
  const oldKeyViewer = await graphql(
    base,
    `
      {
        viewer {
          id
        }
      }
    `,
    undefined,
    issuedKey,
  );
  const replacementViewer = await graphql(
    base,
    `
      {
        viewer {
          id
        }
      }
    `,
    undefined,
    replacementKey,
  );
  const deletedKey = await graphql(
    base,
    `
      mutation ($id: ID!) {
        apiKeyDelete(id: $id) {
          success
        }
      }
    `,
    { id: rotatedKey.data?.apiKeyRotate.apiKey.id },
    replacementKey,
  );
  const deletedKeyViewer = await graphql(
    base,
    `
      {
        viewer {
          id
        }
      }
    `,
    undefined,
    replacementKey,
  );
  const invited = await graphql(
    base,
    `
      mutation ($input: ActorInviteInput!) {
        actorInvite(input: $input) {
          success
          invitation {
            id
            status
            email
          }
          token
        }
      }
    `,
    { input: { email: "concurrent@example.test", name: "Concurrent Agent", type: "AGENT" } },
  );
  const inviteToken = invited.data?.actorInvite.token;
  const inviteAccepts = await Promise.all([
    graphql(
      base,
      `
        mutation ($token: String!, $input: ActorInvitationAcceptInput!) {
          actorInvitationAccept(token: $token, input: $input) {
            success
            actor {
              id
              name
            }
            key
          }
        }
      `,
      { token: inviteToken, input: { name: "Concurrent Agent", type: "AGENT" } },
    ),
    graphql(
      base,
      `
        mutation ($token: String!, $input: ActorInvitationAcceptInput!) {
          actorInvitationAccept(token: $token, input: $input) {
            success
            actor {
              id
              name
            }
            key
          }
        }
      `,
      { token: inviteToken, input: { name: "Concurrent Agent", type: "AGENT" } },
    ),
  ]);
  const accepted = inviteAccepts.filter(
    (result) => !result.errors && result.data?.actorInvitationAccept,
  );
  const acceptedKey =
    accepted.length === 1 ? accepted[0]?.data?.actorInvitationAccept.key : undefined;
  const acceptedViewer = acceptedKey
    ? await graphql(
        base,
        `
          {
            viewer {
              id
            }
          }
        `,
        undefined,
        acceptedKey,
      )
    : { data: undefined, errors: [{ message: "missing accepted key" }] };
  const duplicateInvites = await Promise.all([
    graphql(
      base,
      `
        mutation ($input: ActorInviteInput!) {
          actorInvite(input: $input) {
            success
            invitation {
              id
            }
          }
        }
      `,
      { input: { email: "duplicate@example.test", name: "Duplicate A", type: "HUMAN" } },
    ),
    graphql(
      base,
      `
        mutation ($input: ActorInviteInput!) {
          actorInvite(input: $input) {
            success
            invitation {
              id
            }
          }
        }
      `,
      { input: { email: "duplicate@example.test", name: "Duplicate B", type: "HUMAN" } },
    ),
  ]);
  const sameNameInvites = await Promise.all([
    graphql(
      base,
      `
        mutation ($input: ActorInviteInput!) {
          actorInvite(input: $input) {
            success
            token
          }
        }
      `,
      { input: { email: "same-name-a@example.test", name: "Same Name Invite", type: "AGENT" } },
    ),
    graphql(
      base,
      `
        mutation ($input: ActorInviteInput!) {
          actorInvite(input: $input) {
            success
            token
          }
        }
      `,
      { input: { email: "same-name-b@example.test", name: "Same Name Invite", type: "AGENT" } },
    ),
  ]);
  const sameNameAccepts = await Promise.all(
    sameNameInvites.map((result) =>
      graphql(
        base,
        `
          mutation ($token: String!, $input: ActorInvitationAcceptInput!) {
            actorInvitationAccept(token: $token, input: $input) {
              success
              actor {
                id
                name
              }
            }
          }
        `,
        {
          token: result.data?.actorInvite.token,
          input: { name: "Same Name Invite", type: "AGENT" },
        },
      ),
    ),
  );
  const expiredInvitationToken = generateApiKey();
  await persistence.execute(
    `INSERT INTO actor_invitations
      (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
    [
      newId(),
      "expired@example.test",
      "Expired Invite",
      "human",
      hashApiKey(expiredInvitationToken),
      adminId,
      "{}",
      now(),
      new Date(Date.now() - 1000).toISOString(),
    ],
  );
  const replacedExpiredInvite = await graphql(
    base,
    `
      mutation ($input: ActorInviteInput!) {
        actorInvite(input: $input) {
          success
          invitation {
            status
            email
          }
        }
      }
    `,
    { input: { email: "expired@example.test", name: "Replaced Invite", type: "HUMAN" } },
  );
  const invitedActors = await graphql(
    base,
    `
      {
        actors {
          id
          name
        }
      }
    `,
  );
  const updated = await graphql(
    base,
    `
      mutation ($id: ID!, $input: ActorUpdateInput!) {
        actorUpdate(id: $id, input: $input) {
          success
          actor {
            id
            name
          }
        }
      }
    `,
    { id: actorId, input: { name: "Postgres Agent Updated" } },
  );
  const suspended = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorSuspend(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  const reactivated = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorReactivate(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  const workspace = await graphql(
    base,
    `
      mutation ($input: WorkspaceUpdateInput!) {
        workspaceUpdate(input: $input) {
          success
          workspace {
            id
            name
            urlKey
          }
        }
      }
    `,
    { input: { name: "Postgres Workspace" } },
  );
  const memberLeft = await graphql(
    base,
    `
      mutation {
        actorLeave {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    undefined,
    memberKey,
  );
  const revoked = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorRevoke(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  report.graphql =
    !before.errors &&
    !created.errors &&
    !updated.errors &&
    !suspended.errors &&
    !reactivated.errors &&
    !workspace.errors &&
    !revoked.errors;
  report.identity =
    workspace.data?.workspaceUpdate.workspace.id === workspaceId &&
    updated.data?.actorUpdate.actor.id === actorId &&
    revoked.data?.actorRevoke.actor.status === "LEFT";
  report.lifecycle =
    created.data?.actorCreate.actor.status === "ACTIVE" &&
    suspended.data?.actorSuspend.actor.status === "SUSPENDED" &&
    reactivated.data?.actorReactivate.actor.status === "ACTIVE";
  report.credentials =
    !keyCreated.errors &&
    issuedViewer.data?.viewer.id === adminId &&
    expiredViewer.errors?.[0]?.extensions?.code === "UNAUTHORIZED" &&
    rotatedKey.data?.apiKeyRotate.apiKey.scopes.join(",") === "READ,WRITE" &&
    rotatedKey.data?.apiKeyRotate.apiKey.teamIds?.[0] === teamId &&
    oldKeyViewer.errors?.[0]?.extensions?.code === "UNAUTHORIZED" &&
    replacementViewer.data?.viewer.id === adminId &&
    deletedKey.data?.apiKeyDelete.success === true &&
    deletedKeyViewer.errors?.[0]?.extensions?.code === "UNAUTHORIZED";
  const duplicateSuccesses = duplicateInvites.filter((result) => !result.errors);
  report.invitations =
    !invited.errors &&
    accepted.length === 1 &&
    acceptedViewer.data?.viewer.id === accepted[0]?.data?.actorInvitationAccept.actor.id &&
    invitedActors.data?.actors.filter(
      (actor: { name: string }) => actor.name === "Concurrent Agent",
    ).length === 1 &&
    duplicateSuccesses.length === 1 &&
    duplicateInvites.some(
      (result) => result.errors?.[0]?.extensions?.code === "VALIDATION_FAILED",
    ) &&
    sameNameAccepts.filter((result) => !result.errors).length === 1 &&
    sameNameAccepts.some(
      (result) => result.errors?.[0]?.extensions?.code === "VALIDATION_FAILED",
    ) &&
    invitedActors.data?.actors.filter(
      (actor: { name: string }) => actor.name === "Same Name Invite",
    ).length === 1 &&
    replacedExpiredInvite.data?.actorInvite.success === true &&
    replacedExpiredInvite.data?.actorInvite.invitation.status === "PENDING";
  const teamsBefore = await graphql(
    base,
    `
      {
        teams {
          id
          key
          name
          visibility
          accessPolicy
          states {
            id
            name
            type
            position
          }
          defaultState {
            id
          }
        }
      }
    `,
  );
  const createdTeam = await graphql(
    base,
    `
      mutation ($input: TeamCreateInput!) {
        teamCreate(input: $input) {
          success
          team {
            id
            key
            name
            visibility
            accessPolicy
            states {
              id
              name
              type
              position
            }
            defaultState {
              id
            }
          }
        }
      }
    `,
    {
      input: {
        name: "Postgres Team",
        key: "PGT",
        visibility: "PRIVATE",
        accessPolicy: "TEAM_MEMBERS",
      },
    },
  );
  const createdTeamId = createdTeam.data?.teamCreate.team.id;
  const teamKey = createdTeam.data?.teamCreate.team.key;
  const outsider = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          actor {
            id
          }
        }
      }
    `,
    { input: { name: "Postgres Outsider", type: "AGENT" } },
  );
  const outsiderId = outsider.data?.actorCreate.actor.id;
  const outsiderKeyResult = await graphql(
    base,
    `
      mutation ($id: ID!) {
        apiKeyCreate(input: { actorId: $id, name: "outsider validation key" }) {
          key
        }
      }
    `,
    { id: outsiderId },
  );
  const outsiderKey = outsiderKeyResult.data?.apiKeyCreate.key;
  const acceptedActorId = accepted[0]?.data?.actorInvitationAccept.actor.id;
  const createdMembership = await graphql(
    base,
    `
      mutation ($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) {
          success
          membership {
            id
            actorId
            role
            actor {
              id
            }
            team {
              id
            }
          }
        }
      }
    `,
    { input: { teamId: createdTeamId, actorId: acceptedActorId, role: "MEMBER" } },
  );
  const adminMemberships = await graphql(
    base,
    `
      query ($id: ID!) {
        team(id: $id) {
          memberships {
            id
            actorId
            role
            actor {
              id
            }
            team {
              id
            }
          }
        }
      }
    `,
    { id: createdTeamId },
  );
  const memberMemberships = await graphql(
    base,
    `
      query ($id: ID!) {
        teamMemberships(teamId: $id) {
          id
          actorId
          role
        }
      }
    `,
    { id: createdTeamId },
    acceptedKey,
  );
  const memberCannotManageMembership = await graphql(
    base,
    `
      mutation ($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) {
          success
          membership {
            id
          }
        }
      }
    `,
    {
      input: {
        teamId: createdTeamId,
        actorId: accepted[0]?.data?.actorInvitationAccept.actor.id,
        role: "MEMBER",
      },
    },
    acceptedKey,
  );
  const memberPrivateTeams = await graphql(
    base,
    `
      {
        teams {
          id
        }
      }
    `,
    undefined,
    outsiderKey,
  );
  const unsupportedNested = await graphql(
    base,
    `
      query ($id: ID!) {
        team(id: $id) {
          labels {
            id
          }
        }
      }
    `,
    { id: createdTeamId },
  );
  const initialStateId = createdTeam.data?.teamCreate.team.defaultState.id;
  const createdState = await graphql(
    base,
    `
      mutation ($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) {
          success
          workflowState {
            id
            name
            type
            position
          }
        }
      }
    `,
    { input: { teamId: createdTeamId, name: "Review", type: "STARTED", color: "#abc123" } },
  );
  const stateId = createdState.data?.workflowStateCreate.workflowState.id;
  const issueCreatedAt = new Date(Date.now() - 2000).toISOString();
  const createdIssue = await graphql(
    base,
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
          }
        }
      }
    `,
    {
      input: {
        teamId: createdTeamId,
        title: "First PostgreSQL issue — Definición",
        createdAt: issueCreatedAt,
      },
    },
  );
  const issueIds = [createdIssue.data?.issueCreate.issue.id, newId(), newId(), newId()];
  const updatedIssue = await graphql(
    base,
    `
      mutation ($id: ID!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            title
            priority
          }
        }
      }
    `,
    { id: issueIds[0], input: { title: "First PostgreSQL issue — Definición", priority: 2 } },
  );
  await persistence.execute(
    `INSERT INTO issues
     (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id,
      project_id, creator_id, sort_order, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, NULL, NULL, $7, 0, $8, $8, NULL)`,
    [
      issueIds[1],
      createdTeamId,
      2,
      "Second PostgreSQL issue",
      null,
      initialStateId,
      adminId,
      new Date(Date.now() - 1000).toISOString(),
    ],
  );
  await persistence.execute(
    `INSERT INTO issues
     (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id,
      project_id, creator_id, sort_order, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, NULL, NULL, $7, 0, $8, $8, $9)`,
    [
      issueIds[2],
      createdTeamId,
      3,
      "Archived PostgreSQL issue",
      null,
      initialStateId,
      adminId,
      new Date().toISOString(),
      null,
    ],
  );
  await persistence.execute(
    `INSERT INTO issues
     (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id,
      project_id, creator_id, sort_order, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, $7, NULL, $8, 0, $9, $9, NULL)`,
    [
      issueIds[3],
      createdTeamId,
      4,
      "Child PostgreSQL issue",
      null,
      initialStateId,
      issueIds[0],
      adminId,
      new Date(Date.now() + 1000).toISOString(),
    ],
  );
  const archivedIssue = await graphql(
    base,
    `
      mutation ($id: ID!) {
        issueArchive(id: $id) {
          success
          issue {
            archivedAt
          }
        }
      }
    `,
    { id: issueIds[2] },
  );
  const outsiderIssue = await graphql(
    base,
    `
      query {
        issue(id: "PGT-1") {
          id
        }
      }
    `,
    undefined,
    outsiderKey,
  );
  const memberIssue = await graphql(
    base,
    `
      query {
        issue(id: "PGT-1") {
          identifier
        }
      }
    `,
    undefined,
    acceptedKey,
  );
  const outsiderIssues = await graphql(
    base,
    `
      query {
        issues {
          nodes {
            id
          }
        }
      }
    `,
    undefined,
    outsiderKey,
  );
  const issuePageOne = await graphql(
    base,
    `
      query ($teamId: ID!) {
        issues(first: 2, orderBy: CREATED_ASC, filter: { team: { eq: $teamId } }) {
          nodes {
            id
            identifier
            title
            children {
              id
              identifier
            }
            team {
              id
              key
            }
            state {
              id
              name
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    { teamId: createdTeamId },
  );
  const issuePageTwo = await graphql(
    base,
    `
      query ($teamId: ID!, $after: String!) {
        issues(first: 2, after: $after, orderBy: CREATED_ASC, filter: { team: { eq: $teamId } }) {
          nodes {
            id
            identifier
            title
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    { teamId: createdTeamId, after: issuePageOne.data?.issues.pageInfo.endCursor },
  );
  const directIssue = await graphql(
    base,
    `
      query ($id: ID!) {
        issue(id: $id) {
          id
          identifier
          title
          team {
            key
          }
          state {
            name
          }
        }
      }
    `,
    { id: "PGT-1" },
  );
  const archivedIssues = await graphql(
    base,
    `
      query ($teamId: ID!) {
        active: issues(filter: { team: { eq: $teamId } }) {
          nodes {
            id
          }
        }
        all: issues(filter: { team: { eq: $teamId }, includeArchived: true }) {
          nodes {
            id
          }
        }
      }
    `,
    { teamId: createdTeamId },
  );
  const postgresSearch = await graphql(
    base,
    `
      query ($teamId: ID!, $phrase: String!, $emptySearch: String!) {
        prefix: issues(
          filter: { team: { eq: $teamId }, search: "postgres", includeArchived: true }
        ) {
          nodes {
            id
          }
        }
        phrase: issues(filter: { team: { eq: $teamId }, search: $phrase }) {
          nodes {
            identifier
          }
        }
        accent: issues(filter: { team: { eq: $teamId }, search: "definicion" }) {
          nodes {
            identifier
          }
        }
        ignored: issues(
          filter: { team: { eq: $teamId }, search: $emptySearch, includeArchived: true }
        ) {
          nodes {
            id
          }
        }
        invalid: issues(filter: { team: { eq: $teamId }, search: "*" }) {
          nodes {
            id
          }
        }
      }
    `,
    { teamId: createdTeamId, phrase: '"First PostgreSQL"', emptySearch: '""' },
  );
  const updatedState = await graphql(
    base,
    `
      mutation ($id: ID!, $input: WorkflowStateUpdateInput!) {
        workflowStateUpdate(id: $id, input: $input) {
          success
          workflowState {
            id
            name
            position
          }
        }
      }
    `,
    { id: stateId, input: { name: "QA", position: 10 } },
  );
  const updatedTeam = await graphql(
    base,
    `
      mutation ($id: ID!, $input: TeamUpdateInput!) {
        teamUpdate(id: $id, input: $input) {
          success
          team {
            id
            name
            visibility
            accessPolicy
            defaultState {
              id
            }
          }
        }
      }
    `,
    {
      id: createdTeamId,
      input: { name: "Postgres Team Updated", defaultStateId: stateId },
    },
  );
  const deletedState = await graphql(
    base,
    `
      mutation ($id: ID!, $move: ID) {
        workflowStateDelete(id: $id, moveToStateId: $move) {
          success
          movedIssues
        }
      }
    `,
    { id: stateId, move: initialStateId },
  );
  const archivedTeam = await graphql(
    base,
    `
      mutation ($id: ID!) {
        teamArchive(id: $id) {
          success
          team {
            id
            archivedAt
          }
        }
      }
    `,
    { id: createdTeamId },
  );
  const archivedVisible = await graphql(
    base,
    `
      query ($id: ID!) {
        team(id: $id, includeArchived: true) {
          id
          archivedAt
        }
      }
    `,
    { id: createdTeamId },
  );
  const unarchivedTeam = await graphql(
    base,
    `
      mutation ($id: ID!) {
        teamUnarchive(id: $id) {
          success
          team {
            id
            archivedAt
          }
        }
      }
    `,
    { id: createdTeamId },
  );
  await persistence.execute(
    "DELETE FROM activity WHERE issue_id IN (SELECT id FROM issues WHERE team_id = $1)",
    [createdTeamId],
  );
  await persistence.execute("DELETE FROM issues WHERE team_id = $1", [createdTeamId]);
  const deletedTeam = await graphql(
    base,
    `
      mutation ($id: ID!, $confirmation: String!) {
        teamDelete(id: $id, confirmation: $confirmation) {
          success
        }
      }
    `,
    { id: createdTeamId, confirmation: teamKey },
  );
  report.issues =
    !createdIssue.errors &&
    createdIssue.data?.issueCreate.issue.identifier === "PGT-1" &&
    !updatedIssue.errors &&
    !archivedIssue.errors &&
    !issuePageOne.errors &&
    !issuePageTwo.errors &&
    !createdIssue.errors &&
    !updatedIssue.errors &&
    !archivedIssue.errors &&
    !outsiderIssue.errors &&
    !memberIssue.errors &&
    !outsiderIssues.errors &&
    !directIssue.errors &&
    !archivedIssues.errors &&
    !postgresSearch.errors;
  report.teams =
    !teamsBefore.errors &&
    !createdTeam.errors &&
    createdTeam.data?.teamCreate.team.defaultState.id === initialStateId &&
    !outsider.errors &&
    !outsiderKeyResult.errors &&
    !createdMembership.errors &&
    createdMembership.data?.teamMembershipCreate.membership.actorId === acceptedActorId &&
    adminMemberships.data?.team.memberships.some(
      (membership: { actorId: string; role: string }) =>
        membership.actorId === acceptedActorId && membership.role === "MEMBER",
    ) &&
    !memberMemberships.errors &&
    memberMemberships.data?.teamMemberships.some(
      (membership: { actorId: string }) => membership.actorId === acceptedActorId,
    ) &&
    memberCannotManageMembership.errors?.[0]?.extensions?.code === "NOT_FOUND" &&
    !memberPrivateTeams.errors &&
    !memberPrivateTeams.data?.teams.some((team: { id: string }) => team.id === createdTeamId) &&
    unsupportedNested.errors?.[0]?.extensions?.code === "VALIDATION_FAILED" &&
    !issuePageOne.errors &&
    issuePageOne.data?.issues.nodes.length === 2 &&
    outsiderIssue.data?.issue === null &&
    !outsiderIssues.errors &&
    outsiderIssues.data?.issues.nodes.length === 0 &&
    memberIssue.data?.issue.identifier === "PGT-1" &&
    issuePageOne.data?.issues.nodes[0].children.some(
      (child: { identifier: string }) => child.identifier === "PGT-4",
    ) &&
    !issuePageTwo.errors &&
    issuePageTwo.data?.issues.nodes.length === 1 &&
    directIssue.data?.issue.identifier === "PGT-1" &&
    !archivedIssues.errors &&
    archivedIssues.data?.active.nodes.length === 3 &&
    archivedIssues.data?.all.nodes.length === 4 &&
    !postgresSearch.errors &&
    postgresSearch.data?.prefix.nodes.length === 4 &&
    postgresSearch.data?.phrase.nodes[0].identifier === "PGT-1" &&
    postgresSearch.data?.accent.nodes[0].identifier === "PGT-1" &&
    postgresSearch.data?.ignored.nodes.length === 4 &&
    postgresSearch.data?.invalid.nodes.length === 0 &&
    !createdState.errors &&
    updatedState.data?.workflowStateUpdate.workflowState.name === "QA" &&
    updatedTeam.data?.teamUpdate.team.defaultState.id === stateId &&
    deletedState.data?.workflowStateDelete.movedIssues === 0 &&
    archivedTeam.data?.teamArchive.team.archivedAt !== null &&
    archivedVisible.data?.team.archivedAt !== null &&
    unarchivedTeam.data?.teamUnarchive.team.archivedAt === null &&
    deletedTeam.data?.teamDelete.success === true;
  const finalWorkspace = await graphql(
    base,
    `
      {
        workspace {
          id
          name
        }
      }
    `,
  );
  report.updatedWorkspace =
    finalWorkspace.data?.workspace.id === workspaceId &&
    finalWorkspace.data?.workspace.name === "Postgres Workspace";
  report.authorization =
    memberViewer.data?.viewer.id === memberId &&
    memberDenied.errors?.[0]?.extensions?.code === "UNAUTHORIZED" &&
    memberLeft.data?.actorLeave.actor.id === memberId &&
    memberLeft.data?.actorLeave.actor.status === "LEFT";
  const passed = Object.values(report).every((value) => value === true);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  server?.stop();
  db.close();
  await persistence?.close();
  if (!persistence) await sql.close({ timeout: 5 });
}
