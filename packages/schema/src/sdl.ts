// SDL del esquema GraphQL de prime-board (docs/specs/mvp.md §4).
// Este archivo se regenera por secciones a medida que crece la API (AT-132+).
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum ActorType {
    HUMAN
    AGENT
  }

  enum ActorWorkspaceRole {
    ADMIN
    MEMBER
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
    workspaceRole: ActorWorkspaceRole!
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
    """
    Donde caen los issues creados sin estado explícito. Editable vía teamUpdate.
    """
    defaultState: WorkflowState!
    labels: [Label!]!
    projects: [Project!]!
    cycles: [Cycle!]!
    memberships: [TeamMembership!]!
    createdAt: DateTime!
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    """
    NULL para labels de workspace.
    """
    teamId: ID
  }

  enum TeamMembershipRole {
    OWNER
    MEMBER
  }

  type TeamMembership {
    id: ID!
    teamId: ID!
    actorId: ID!
    team: Team!
    actor: Actor!
    role: TeamMembershipRole!
    createdAt: DateTime!
  }

  input TeamMembershipCreateInput {
    teamId: ID!
    actorId: ID!
    role: TeamMembershipRole
  }

  type TeamMembershipPayload {
    success: Boolean!
    membership: TeamMembership!
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
    """
    Identificador legible e inmutable, p. ej. AT-126.
    """
    identifier: String!
    title: String!
    description: String
    team: Team!
    state: WorkflowState!
    """
    0 none, 1 urgent, 2 high, 3 medium, 4 low (como Linear).
    """
    priority: Int!
    assignee: Actor
    creator: Actor!
    parent: Issue
    children: [Issue!]!
    labels: [Label!]!
    project: Project
    milestone: Milestone
    cycle: Cycle
    comments: [Comment!]!
    """
    Relaciones con otros issues (bloqueo, related, duplicados), desde ambos extremos.
    """
    relations: [IssueRelation!]!
    """
    Historial append-only de cambios del issue.
    """
    activity: [Activity!]!
    """
    Deep-link a la UI.
    """
    url: String!
    """
    Nombre de branch sugerido, p. ej. agent/at-126-titulo.
    """
    branchName: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  enum IssueRelationType {
    """
    Este issue bloquea al relacionado.
    """
    BLOCKS
    """
    Este issue está bloqueado por el relacionado.
    """
    BLOCKED_BY
    """
    Relación simétrica: ambos extremos la ven igual.
    """
    RELATED
    """
    Este issue duplica al relacionado.
    """
    DUPLICATE_OF
    """
    El relacionado duplica a este issue.
    """
    DUPLICATED_BY
  }

  """
  Relación entre dos issues, vista desde el issue consultado.
  """
  type IssueRelation {
    id: ID!
    """
    Tipo desde la perspectiva del issue consultado (el otro extremo ve la inversa).
    """
    type: IssueRelationType!
    """
    El issue del otro extremo.
    """
    relatedIssue: Issue!
    createdAt: DateTime!
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

  """
  Entrada del inbox personal del viewer (PRB-202).
  """
  type InboxItem {
    id: ID!
    type: String!
    actor: Actor!
    issue: Issue!
    payload: JSON!
    createdAt: DateTime!
    isRead: Boolean!
    isArchived: Boolean!
  }

  type InboxItemPayload {
    success: Boolean!
    inboxItem: InboxItem!
  }

  enum CycleState {
    UPCOMING
    ACTIVE
    COMPLETED
  }

  """
  Ciclo time-boxed de un team (PRB-203).
  """
  type Cycle {
    id: ID!
    team: Team!
    number: Int!
    name: String!
    startsAt: DateTime!
    endsAt: DateTime!
    state: CycleState!
    """
    Issues completados / total (no archivados).
    """
    progress: Float!
    completedIssues: Int!
    totalIssues: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  input CycleCreateInput {
    teamId: ID!
    name: String!
    startsAt: DateTime!
    endsAt: DateTime!
    state: CycleState
  }

  input CycleUpdateInput {
    name: String
    startsAt: DateTime
    endsAt: DateTime
    state: CycleState
    archived: Boolean
  }

  type CyclePayload {
    success: Boolean!
    cycle: Cycle!
  }

  type CycleCarryOverPayload {
    success: Boolean!
    movedIssues: Int!
  }

  enum ReviewStatus {
    REQUESTED
    IN_PROGRESS
    APPROVED
    REJECTED
  }

  """
  Solicitud de revisión sobre un issue (PRB-205).
  """
  type Review {
    id: ID!
    issue: Issue!
    requester: Actor!
    reviewer: Actor!
    status: ReviewStatus!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input ReviewCreateInput {
    issueId: ID!
    reviewerId: ID!
  }

  input ReviewUpdateInput {
    status: ReviewStatus
    reviewerId: ID
  }

  type ReviewPayload {
    success: Boolean!
    review: Review!
  }

  enum InitiativeState {
    PLANNED
    ACTIVE
    COMPLETED
    CANCELED
  }

  """
  Iniciativa de workspace que agrupa proyectos (PRB-206).
  """
  type Initiative {
    id: ID!
    name: String!
    description: String
    state: InitiativeState!
    targetDate: DateTime
    projects: [Project!]!
    teams: [Team!]!
    owner: Actor
    """
    Issues completados / total en proyectos de la iniciativa.
    """
    progress: Float!
    completedIssues: Int!
    totalIssues: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  input InitiativeCreateInput {
    name: String!
    description: String
    state: InitiativeState
    targetDate: DateTime
    projectIds: [ID!]
    teamIds: [ID!]
  }

  input InitiativeUpdateInput {
    name: String
    description: String
    state: InitiativeState
    targetDate: DateTime
    projectIds: [ID!]
    teamIds: [ID!]
    archived: Boolean
  }

  type InitiativePayload {
    success: Boolean!
    initiative: Initiative!
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
    """
    Historial de actualizaciones narrativas (PRB-207).
    """
    updates: [ProjectStatusUpdate!]!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  enum ProjectUpdateHealth {
    ON_TRACK
    AT_RISK
    OFF_TRACK
  }

  """
  Update narrativo de un proyecto (estado/riesgos/próximos pasos).
  """
  type ProjectStatusUpdate {
    id: ID!
    project: Project!
    author: Actor!
    health: ProjectUpdateHealth!
    body: String!
    risks: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input ProjectUpdateCreateInput {
    projectId: ID!
    health: ProjectUpdateHealth!
    body: String!
    risks: String
  }

  type ProjectStatusUpdatePayload {
    success: Boolean!
    projectUpdate: ProjectStatusUpdate!
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
    """
    Issues completados sobre el total (0..1).
    """
    progress: Float!
    createdAt: DateTime!
  }

  input TeamCreateInput {
    name: String!
    key: String!
    description: String
  }

  input TeamUpdateInput {
    name: String
    description: String
    """
    Debe ser un estado del team.
    """
    defaultStateId: ID
  }

  input ActorCreateInput {
    name: String!
    type: ActorType!
    email: String
  }

  input ActorUpdateInput {
    name: String
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
    """
    La key en claro. Se devuelve una única vez: solo se persiste su hash.
    """
    key: String!
  }

  type WorkflowStatePayload {
    success: Boolean!
    workflowState: WorkflowState!
  }

  input LabelCreateInput {
    name: String!
    color: String
    """
    Omitir para crear una label de workspace.
    """
    teamId: ID
  }

  type LabelPayload {
    success: Boolean!
    label: Label!
  }

  input WorkflowStateUpdateInput {
    name: String
    type: StateType
    color: String
    position: Float
  }

  input LabelUpdateInput {
    name: String
    color: String
  }

  type LabelDeletePayload {
    success: Boolean!
    """
    Cantidad de issues de los que se quitó la label.
    """
    affectedIssues: Int!
  }

  type WorkflowStateDeletePayload {
    success: Boolean!
    """
    Issues migrados al estado destino.
    """
    movedIssues: Int!
  }

  input IDComparator {
    eq: ID
    neq: ID
    in: [ID!]
    nin: [ID!]
    """
    true: el campo es NULL; false: no es NULL.
    """
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

  """
  Filtro componible: los campos se combinan con AND; and/or anidan sub-filtros.
  """
  input IssueFilter {
    team: IDComparator
    state: IDComparator
    stateType: StateTypeComparator
    assignee: IDComparator
    creator: IDComparator
    project: IDComparator
    milestone: IDComparator
    cycle: IDComparator
    parent: IDComparator
    priority: IntComparator
    labels: LabelComparator
    """
    Full-text sobre título y descripción.
    """
    search: String
    """
    true: issues abiertos con todos sus bloqueantes cerrados (frontier); false: con al menos un bloqueante abierto.
    """
    unblocked: Boolean
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
    """
    Fija el número del identificador (para imports); default: numeración automática.
    """
    number: Int
    title: String!
    description: String
    stateId: ID
    priority: Int
    assigneeId: ID
    parentId: ID
    projectId: ID
    milestoneId: ID
    """
    Labels a aplicar al crear (evita un issueUpdate extra).
    """
    labelIds: [ID!]
    """
    Fecha de creación original (imports); default: ahora.
    """
    createdAt: DateTime
    """
    Autor original (imports); default: el actor de la API key.
    """
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
    cycleId: ID
    sortOrder: Float
    """
    Reemplaza el set completo de labels.
    """
    labelIds: [ID!]
    addLabelIds: [ID!]
    removeLabelIds: [ID!]
  }

  type IssuePayload {
    success: Boolean!
    issue: Issue!
  }

  input IssueRelationCreateInput {
    """
    Acepta UUID o identificador legible (AT-126).
    """
    issueId: ID!
    relatedIssueId: ID!
    """
    El tipo desde la perspectiva de issueId; se normaliza al guardar.
    """
    type: IssueRelationType!
  }

  type IssueRelationPayload {
    success: Boolean!
    relation: IssueRelation!
  }

  input CommentCreateInput {
    """
    Acepta UUID o identificador legible (AT-126).
    """
    issueId: ID!
    body: String!
    """
    Fecha original (imports); default: ahora.
    """
    createdAt: DateTime
    """
    Autor original (imports); default: el actor de la API key.
    """
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
    """
    Teams del proyecto; omitir = todos los teams actuales (compat).
    """
    teamIds: [ID!]
  }

  input ProjectUpdateInput {
    name: String
    description: String
    state: ProjectState
    leadId: ID
    targetDate: DateTime
    """
    Reemplaza el set de teams del proyecto.
    """
    teamIds: [ID!]
  }

  type ProjectPayload {
    success: Boolean!
    project: Project!
  }

  input WebhookCreateInput {
    url: String!
    """
    Omitir para autogenerar; se devuelve una única vez.
    """
    secret: String
    """
    Eventos suscriptos; omitir para todos ("*").
    """
    events: [String!]
  }

  type WebhookPayload {
    success: Boolean!
    webhook: Webhook!
    """
    El secret con el que se firman las entregas. Guardalo: no se vuelve a mostrar.
    """
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

  type MilestoneDeletePayload {
    success: Boolean!
    """
    Cantidad de issues que quedaron sin milestone.
    """
    orphanedIssues: Int!
  }

  enum SavedViewScope {
    PERSONAL
    TEAM
    WORKSPACE
  }

  """
  Vista guardada: filtros/orden/agrupación reutilizables (PRB-201).
  """
  type SavedView {
    id: ID!
    name: String!
    scope: SavedViewScope!
    team: Team
    owner: Actor!
    """
    Filtro IssueFilter serializado (JSON).
    """
    filter: JSON!
    orderBy: IssueOrder!
    """
    Criterio de agrupación de la UI: state | milestone | assignee | priority.
    """
    groupBy: String!
    """
    Columnas visibles de la lista (ids de campo).
    """
    columns: [String!]!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  input SavedViewCreateInput {
    name: String!
    scope: SavedViewScope!
    teamId: ID
    filter: JSON
    orderBy: IssueOrder
    groupBy: String
    columns: [String!]
  }

  input SavedViewUpdateInput {
    name: String
    filter: JSON
    orderBy: IssueOrder
    groupBy: String
    columns: [String!]
    archived: Boolean
  }

  type SavedViewPayload {
    success: Boolean!
    savedView: SavedView!
  }

  type Favorite {
    id: ID!
    position: Float!
    project: Project
    savedView: SavedView
  }

  input FavoriteCreateInput {
    projectId: ID
    savedViewId: ID
  }

  type FavoritePayload {
    success: Boolean!
    favorite: Favorite!
  }

  type Query {
    """
    Actor autenticado por la API key del header Authorization.
    """
    viewer: Actor!
    workspace: Workspace!
    teams: [Team!]!
    team(id: ID, key: String): Team
    actors(type: ActorType): [Actor!]!
    teamMemberships(teamId: ID!): [TeamMembership!]!
    """
    Acepta UUID o identificador legible (AT-126).
    """
    issue(id: ID!): Issue
    issues(
      filter: IssueFilter
      first: Int = 50
      after: String
      orderBy: IssueOrder = CREATED_DESC
    ): IssueConnection!
    """
    Labels visibles para un team (workspace + propias); sin team, todas.
    """
    labels(team: ID): [Label!]!
    projects(state: ProjectState, team: ID, includeArchived: Boolean = false): [Project!]!
    project(id: ID!): Project
    webhooks: [Webhook!]!
    """
    Vistas visibles para el viewer. Con teamId: team + workspace + personales.
    """
    savedViews(teamId: ID, includeArchived: Boolean = false): [SavedView!]!
    savedView(id: ID!): SavedView
    favorites: [Favorite!]!
    """
    Eventos relevantes para el actor autenticado (asignaciones, comentarios en sus issues).
    """
    inbox(first: Int = 50, includeArchived: Boolean = false): [InboxItem!]!
    cycles(teamId: ID!, includeArchived: Boolean = false): [Cycle!]!
    cycle(id: ID!): Cycle
    """
    Cola de revisiones del viewer (como reviewer o requester).
    """
    reviews(
      openOnly: Boolean = false
      first: Int = 50
      teamId: ID
      projectId: ID
      reviewerId: ID
      olderThanDays: Int
    ): [Review!]!
    review(id: ID!): Review
    initiatives(includeArchived: Boolean = false): [Initiative!]!
    initiative(id: ID!): Initiative
  }

  type Mutation {
    teamCreate(input: TeamCreateInput!): TeamPayload!
    teamUpdate(id: ID!, input: TeamUpdateInput!): TeamPayload!
    teamMembershipCreate(input: TeamMembershipCreateInput!): TeamMembershipPayload!
    teamMembershipDelete(id: ID!): DeletePayload!
    actorCreate(input: ActorCreateInput!): ActorPayload!
    actorUpdate(id: ID!, input: ActorUpdateInput!): ActorPayload!
    apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!
    apiKeyDelete(id: ID!): DeletePayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
    workflowStateUpdate(id: ID!, input: WorkflowStateUpdateInput!): WorkflowStatePayload!
    """
    Borra el estado; moveToStateId es obligatorio si tiene issues.
    """
    workflowStateDelete(id: ID!, moveToStateId: ID): WorkflowStateDeletePayload!
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!
    issueArchive(id: ID!): IssuePayload!
    labelCreate(input: LabelCreateInput!): LabelPayload!
    labelUpdate(id: ID!, input: LabelUpdateInput!): LabelPayload!
    labelDelete(id: ID!): LabelDeletePayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    issueRelationCreate(input: IssueRelationCreateInput!): IssueRelationPayload!
    issueRelationDelete(id: ID!): DeletePayload!
    projectCreate(input: ProjectCreateInput!): ProjectPayload!
    projectUpdate(id: ID!, input: ProjectUpdateInput!): ProjectPayload!
    projectArchive(id: ID!): ProjectPayload!
    projectUnarchive(id: ID!): ProjectPayload!
    milestoneCreate(input: MilestoneCreateInput!): MilestonePayload!
    milestoneUpdate(id: ID!, input: MilestoneUpdateInput!): MilestonePayload!
    """
    Borra el milestone; los issues asignados quedan sin milestone.
    """
    milestoneDelete(id: ID!): MilestoneDeletePayload!
    savedViewCreate(input: SavedViewCreateInput!): SavedViewPayload!
    savedViewUpdate(id: ID!, input: SavedViewUpdateInput!): SavedViewPayload!
    savedViewDuplicate(id: ID!): SavedViewPayload!
    savedViewDelete(id: ID!): DeletePayload!
    favoriteCreate(input: FavoriteCreateInput!): FavoritePayload!
    favoriteDelete(id: ID!): DeletePayload!
    favoriteReorder(id: ID!, position: Int!): FavoritePayload!
    cycleCreate(input: CycleCreateInput!): CyclePayload!
    cycleUpdate(id: ID!, input: CycleUpdateInput!): CyclePayload!
    cycleDelete(id: ID!): DeletePayload!
    """
    Mueve issues abiertos del ciclo origen al destino.
    """
    cycleCarryOver(fromCycleId: ID!, toCycleId: ID!): CycleCarryOverPayload!
    reviewCreate(input: ReviewCreateInput!): ReviewPayload!
    reviewUpdate(id: ID!, input: ReviewUpdateInput!): ReviewPayload!
    reviewDelete(id: ID!): DeletePayload!
    initiativeCreate(input: InitiativeCreateInput!): InitiativePayload!
    initiativeUpdate(id: ID!, input: InitiativeUpdateInput!): InitiativePayload!
    initiativeDelete(id: ID!): DeletePayload!
    projectUpdateCreate(input: ProjectUpdateCreateInput!): ProjectStatusUpdatePayload!
    projectUpdateDelete(id: ID!): DeletePayload!
    inboxMarkRead(id: ID!): InboxItemPayload!
    inboxArchive(id: ID!): InboxItemPayload!
    webhookCreate(input: WebhookCreateInput!): WebhookPayload!
    webhookDelete(id: ID!): DeletePayload!
  }
`;
