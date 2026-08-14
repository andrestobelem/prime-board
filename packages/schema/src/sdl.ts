// SDL del esquema GraphQL de prime-board (docs/specs/mvp.md §4).
// Este archivo se regenera por secciones a medida que crece la API (AT-132+).
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum ActorType {
    HUMAN
    AGENT
  }

  enum StateType {
    TRIAGE
    BACKLOG
    UNSTARTED
    STARTED
    COMPLETED
    CANCELED
  }

  type Actor {
    id: ID!
    name: String!
    email: String
    type: ActorType!
    createdAt: DateTime!
  }

  type Workspace {
    id: ID!
    name: String!
    urlKey: String!
    createdAt: DateTime!
  }

  type WorkflowState {
    id: ID!
    name: String!
    type: StateType!
    color: String!
    position: Float!
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    description: String
    states: [WorkflowState!]!
    createdAt: DateTime!
  }

  type ApiKey {
    id: ID!
    name: String!
    actor: Actor!
    createdAt: DateTime!
    lastUsedAt: DateTime
  }

  input TeamCreateInput {
    name: String!
    key: String!
    description: String
  }

  input ActorCreateInput {
    name: String!
    type: ActorType!
    email: String
  }

  input ApiKeyCreateInput {
    actorId: ID!
    name: String!
  }

  input WorkflowStateCreateInput {
    teamId: ID!
    name: String!
    type: StateType!
    color: String
    position: Float
  }

  type TeamPayload {
    success: Boolean!
    team: Team!
  }

  type ActorPayload {
    success: Boolean!
    actor: Actor!
  }

  type ApiKeyPayload {
    success: Boolean!
    apiKey: ApiKey!
    """La key en claro. Se devuelve una única vez: solo se persiste su hash."""
    key: String!
  }

  type WorkflowStatePayload {
    success: Boolean!
    workflowState: WorkflowState!
  }

  type Query {
    """Actor autenticado por la API key del header Authorization."""
    viewer: Actor!
    workspace: Workspace!
    teams: [Team!]!
    team(id: ID, key: String): Team
    actors(type: ActorType): [Actor!]!
  }

  type Mutation {
    teamCreate(input: TeamCreateInput!): TeamPayload!
    actorCreate(input: ActorCreateInput!): ActorPayload!
    apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
  }
`;
