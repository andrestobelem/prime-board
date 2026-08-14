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
    labels: [Label!]!
    createdAt: DateTime!
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    """NULL para labels de workspace."""
    teamId: ID
  }

  type ApiKey {
    id: ID!
    name: String!
    actor: Actor!
    createdAt: DateTime!
    lastUsedAt: DateTime
  }

  type Issue {
    id: ID!
    """Identificador legible e inmutable, p. ej. AT-126."""
    identifier: String!
    title: String!
    description: String
    team: Team!
    state: WorkflowState!
    """0 none, 1 urgent, 2 high, 3 medium, 4 low (como Linear)."""
    priority: Int!
    assignee: Actor
    creator: Actor!
    parent: Issue
    children: [Issue!]!
    labels: [Label!]!
    """Deep-link a la UI."""
    url: String!
    """Nombre de branch sugerido, p. ej. agent/at-126-titulo."""
    branchName: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type IssueConnection {
    nodes: [Issue!]!
    pageInfo: PageInfo!
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

  input LabelCreateInput {
    name: String!
    color: String
    """Omitir para crear una label de workspace."""
    teamId: ID
  }

  type LabelPayload {
    success: Boolean!
    label: Label!
  }

  input IDComparator {
    eq: ID
    in: [ID!]
  }

  """Filtro mínimo (AT-134); se amplía con and/or, search y más comparadores en AT-138."""
  input IssueFilter {
    team: IDComparator
    state: IDComparator
    assignee: IDComparator
  }

  input IssueCreateInput {
    teamId: ID
    teamKey: String
    title: String!
    description: String
    stateId: ID
    priority: Int
    assigneeId: ID
    parentId: ID
    projectId: ID
  }

  input IssueUpdateInput {
    title: String
    description: String
    stateId: ID
    priority: Int
    assigneeId: ID
    parentId: ID
    projectId: ID
    sortOrder: Float
    """Reemplaza el set completo de labels."""
    labelIds: [ID!]
    addLabelIds: [ID!]
    removeLabelIds: [ID!]
  }

  type IssuePayload {
    success: Boolean!
    issue: Issue!
  }

  type Query {
    """Actor autenticado por la API key del header Authorization."""
    viewer: Actor!
    workspace: Workspace!
    teams: [Team!]!
    team(id: ID, key: String): Team
    actors(type: ActorType): [Actor!]!
    """Acepta UUID o identificador legible (AT-126)."""
    issue(id: ID!): Issue
    issues(filter: IssueFilter, first: Int = 50, after: String): IssueConnection!
    """Labels visibles para un team (workspace + propias); sin team, todas."""
    labels(team: ID): [Label!]!
  }

  type Mutation {
    teamCreate(input: TeamCreateInput!): TeamPayload!
    actorCreate(input: ActorCreateInput!): ActorPayload!
    apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!
    issueArchive(id: ID!): IssuePayload!
    labelCreate(input: LabelCreateInput!): LabelPayload!
  }
`;
