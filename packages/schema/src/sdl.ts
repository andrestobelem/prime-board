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
    apiKeys: [ApiKey!]!
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
    projects: [Project!]!
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
    project: Project
    milestone: Milestone
    comments: [Comment!]!
    """Historial append-only de cambios del issue."""
    activity: [Activity!]!
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

  type Comment {
    id: ID!
    body: String!
    actor: Actor!
    issue: Issue!
    createdAt: DateTime!
    editedAt: DateTime
  }

  type Activity {
    id: ID!
    type: String!
    actor: Actor!
    payload: JSON!
    createdAt: DateTime!
  }

  enum ProjectState {
    BACKLOG
    PLANNED
    STARTED
    PAUSED
    COMPLETED
    CANCELED
  }

  type Project {
    id: ID!
    name: String!
    description: String
    state: ProjectState!
    lead: Actor
    targetDate: DateTime
    teams: [Team!]!
    milestones: [Milestone!]!
    issues(first: Int = 50): IssueConnection!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  type Webhook {
    id: ID!
    url: String!
    events: [String!]!
    enabled: Boolean!
    createdAt: DateTime!
  }

  type Milestone {
    id: ID!
    name: String!
    description: String
    targetDate: DateTime
    position: Float!
    project: Project!
    issues(first: Int = 100): IssueConnection!
    """Issues completados sobre el total (0..1)."""
    progress: Float!
    createdAt: DateTime!
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
    neq: ID
    in: [ID!]
    nin: [ID!]
    """true: el campo es NULL; false: no es NULL."""
    null: Boolean
  }

  input IntComparator {
    eq: Int
    neq: Int
    in: [Int!]
    gte: Int
    lte: Int
  }

  input StateTypeComparator {
    eq: StateType
    in: [StateType!]
  }

  input LabelComparator {
    includes: ID
    includesAll: [ID!]
  }

  """Filtro componible: los campos se combinan con AND; and/or anidan sub-filtros."""
  input IssueFilter {
    team: IDComparator
    state: IDComparator
    stateType: StateTypeComparator
    assignee: IDComparator
    creator: IDComparator
    project: IDComparator
    milestone: IDComparator
    parent: IDComparator
    priority: IntComparator
    labels: LabelComparator
    """Full-text sobre título y descripción."""
    search: String
    includeArchived: Boolean
    and: [IssueFilter!]
    or: [IssueFilter!]
  }

  enum IssueOrder {
    CREATED_ASC
    CREATED_DESC
    UPDATED_ASC
    UPDATED_DESC
  }

  input IssueCreateInput {
    teamId: ID
    teamKey: String
    """Fija el número del identificador (para imports); default: numeración automática."""
    number: Int
    title: String!
    description: String
    stateId: ID
    priority: Int
    assigneeId: ID
    parentId: ID
    projectId: ID
    milestoneId: ID
    """Labels a aplicar al crear (evita un issueUpdate extra)."""
    labelIds: [ID!]
    """Fecha de creación original (imports); default: ahora."""
    createdAt: DateTime
    """Autor original (imports); default: el actor de la API key."""
    creatorId: ID
  }

  input IssueUpdateInput {
    title: String
    description: String
    stateId: ID
    priority: Int
    assigneeId: ID
    parentId: ID
    projectId: ID
    milestoneId: ID
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

  input CommentCreateInput {
    """Acepta UUID o identificador legible (AT-126)."""
    issueId: ID!
    body: String!
    """Fecha original (imports); default: ahora."""
    createdAt: DateTime
    """Autor original (imports); default: el actor de la API key."""
    authorId: ID
  }

  type CommentPayload {
    success: Boolean!
    comment: Comment!
  }

  input ProjectCreateInput {
    name: String!
    description: String
    state: ProjectState
    leadId: ID
    targetDate: DateTime
    """Teams del proyecto; omitir = todos los teams actuales (compat)."""
    teamIds: [ID!]
  }

  input ProjectUpdateInput {
    name: String
    description: String
    state: ProjectState
    leadId: ID
    targetDate: DateTime
    """Reemplaza el set de teams del proyecto."""
    teamIds: [ID!]
  }

  type ProjectPayload {
    success: Boolean!
    project: Project!
  }

  input WebhookCreateInput {
    url: String!
    """Omitir para autogenerar; se devuelve una única vez."""
    secret: String
    """Eventos suscriptos; omitir para todos ("*")."""
    events: [String!]
  }

  type WebhookPayload {
    success: Boolean!
    webhook: Webhook!
    """El secret con el que se firman las entregas. Guardalo: no se vuelve a mostrar."""
    secret: String!
  }

  type DeletePayload {
    success: Boolean!
  }

  input MilestoneCreateInput {
    projectId: ID!
    name: String!
    description: String
    targetDate: DateTime
    position: Float
  }

  input MilestoneUpdateInput {
    name: String
    description: String
    targetDate: DateTime
    position: Float
  }

  type MilestonePayload {
    success: Boolean!
    milestone: Milestone!
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
    issues(filter: IssueFilter, first: Int = 50, after: String, orderBy: IssueOrder = CREATED_DESC): IssueConnection!
    """Labels visibles para un team (workspace + propias); sin team, todas."""
    labels(team: ID): [Label!]!
    projects(state: ProjectState, team: ID): [Project!]!
    project(id: ID!): Project
    webhooks: [Webhook!]!
  }

  type Mutation {
    teamCreate(input: TeamCreateInput!): TeamPayload!
    actorCreate(input: ActorCreateInput!): ActorPayload!
    apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!
    apiKeyDelete(id: ID!): DeletePayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!
    issueArchive(id: ID!): IssuePayload!
    labelCreate(input: LabelCreateInput!): LabelPayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    projectCreate(input: ProjectCreateInput!): ProjectPayload!
    projectUpdate(id: ID!, input: ProjectUpdateInput!): ProjectPayload!
    milestoneCreate(input: MilestoneCreateInput!): MilestonePayload!
    milestoneUpdate(id: ID!, input: MilestoneUpdateInput!): MilestonePayload!
    webhookCreate(input: WebhookCreateInput!): WebhookPayload!
    webhookDelete(id: ID!): DeletePayload!
  }
`;
