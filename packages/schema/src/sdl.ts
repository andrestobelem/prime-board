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

  enum ActorStatus {
    ACTIVE
    SUSPENDED
    LEFT
  }

  enum ActorInvitationStatus {
    PENDING
    ACCEPTED
    REVOKED
    EXPIRED
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
    status: ActorStatus!
    apiKeys: [ApiKey!]!
    """
    Workspaces granted to this Actor through the current credential.
    """
    workspaces: [Workspace!]!
    createdAt: DateTime!
  }

  type Workspace {
    id: ID!
    name: String!
    urlKey: String!
    createdAt: DateTime!
    role: ActorWorkspaceRole!
    status: ActorStatus!
    isDefault: Boolean!
  }

  input WorkspaceCreateInput {
    name: String!
    urlKey: String!
  }

  input WorkspaceUpdateInput {
    name: String!
  }

  type WorkspacePayload {
    success: Boolean!
    workspace: Workspace!
  }

  type WorkflowState {
    id: ID!
    name: String!
    type: StateType!
    color: String!
    position: Float!
  }

  enum TeamVisibility {
    PUBLIC
    PRIVATE
  }

  enum TeamAccessPolicy {
    WORKSPACE_MEMBERS
    TEAM_MEMBERS
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    description: String
    visibility: TeamVisibility!
    accessPolicy: TeamAccessPolicy!
    states: [WorkflowState!]!
    """
    The default destination for issues created without an explicit state. Editable through teamUpdate.
    """
    defaultState: WorkflowState!
    labels: [Label!]!
    projects: [Project!]!
    cycles: [Cycle!]!
    memberships: [TeamMembership!]!
    documents(includeArchived: Boolean = false): [Document!]!
    createdAt: DateTime!
    archivedAt: DateTime
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    """
    NULL for Workspace labels.
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

  enum ApiKeyScope {
    READ
    WRITE
    ADMIN
  }

  type ApiKey {
    id: ID!
    name: String!
    actor: Actor!
    createdAt: DateTime!
    lastUsedAt: DateTime
    revokedAt: DateTime
    expiresAt: DateTime
    rotatedFromId: ID
    scopes: [ApiKeyScope!]!
    """
    Team IDs allowed by this key; empty means every Team.
    """
    teamIds: [ID!]!
  }

  type ActorInvitation {
    id: ID!
    email: String
    name: String
    type: ActorType
    status: ActorInvitationStatus!
    invitedBy: Actor!
    actor: Actor
    actorId: ID
    metadata: JSON!
    createdAt: DateTime!
    expiresAt: DateTime!
    acceptedAt: DateTime
    revokedAt: DateTime
  }

  input ActorInviteInput {
    email: String
    name: String
    type: ActorType
    expiresAt: DateTime
    metadata: JSON
  }

  input ActorInvitationAcceptInput {
    name: String
    type: ActorType
  }

  type ActorInvitationPayload {
    success: Boolean!
    invitation: ActorInvitation!
    """
    Plaintext token; returned only when the invitation is created.
    """
    token: String!
  }

  type ActorInvitationAcceptPayload {
    success: Boolean!
    invitation: ActorInvitation!
    actor: Actor!
    """
    Plaintext API key; returned only when the invitation is accepted.
    """
    key: String!
  }

  type ActorInvitationRevokePayload {
    success: Boolean!
    invitation: ActorInvitation!
  }

  type Issue {
    id: ID!
    """
    Readable, immutable identifier, for example AT-126.
    """
    identifier: String!
    title: String!
    description: String
    team: Team!
    state: WorkflowState
    """
    0 none, 1 urgent, 2 high, 3 medium, 4 low (as in Linear).
    """
    priority: Int!
    assignee: Actor
    creator: Actor!
    """
    Actors that follow this issue.
    """
    subscribers: [Actor!]!
    parent: Issue
    children(includeArchived: Boolean = false): [Issue!]!
    labels: [Label!]!
    project: Project
    milestone: Milestone
    cycle: Cycle
    sortOrder: Float!
    comments: [Comment!]!
    documents(includeArchived: Boolean = false): [Document!]!
    """
    Relations with other issues (blocking, related, and duplicates), from both ends.
    """
    relations: [IssueRelation!]!
    """
    Append-only history of changes to the issue.
    """
    activity: [Activity!]!
    """
    Deep link to the UI.
    """
    url: String!
    """
    Suggested branch name, for example agent/at-126-title.
    """
    branchName: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  enum IssueRelationType {
    """
    This issue blocks the related issue.
    """
    BLOCKS
    """
    This issue is blocked by the related issue.
    """
    BLOCKED_BY
    """
    Symmetric relation: both ends see the same relation.
    """
    RELATED
    """
    This issue duplicates the related issue.
    """
    DUPLICATE_OF
    """
    The related issue duplicates this issue.
    """
    DUPLICATED_BY
  }

  """
  Relation between two issues, viewed from the queried issue.
  """
  type IssueRelation {
    id: ID!
    """
    Type from the perspective of the queried issue (the other end sees the inverse).
    """
    type: IssueRelationType!
    """
    The issue at the other end.
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

  """
  Global Markdown document or document linked to a work resource.
  """
  type Document {
    id: ID!
    title: String!
    content: String!
    creator: Actor!
    issue: Issue
    project: Project
    team: Team
    initiative: Initiative
    cycle: Cycle
    url: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  input DocumentCreateInput {
    title: String!
    content: String
    issueId: ID
    projectId: ID
    teamId: ID
    initiativeId: ID
    cycleId: ID
  }

  input DocumentUpdateInput {
    title: String
    content: String
    archived: Boolean
  }

  type DocumentPayload {
    success: Boolean!
    document: Document!
  }

  type Activity {
    id: ID!
    type: String!
    actor: Actor!
    workspaceId: ID!
    payload: JSON!
    createdAt: DateTime!
  }

  """
  Entry in the viewer's personal inbox (PRB-202).
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

  type InboxConnection {
    nodes: [InboxItem!]!
    pageInfo: PageInfo!
  }

  enum CycleState {
    UPCOMING
    ACTIVE
    COMPLETED
  }

  """
  Time-boxed cycle for a Team (PRB-203).
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
    Completed / total issues (excluding archived issues).
    """
    progress: Float!
    completedIssues: Int!
    totalIssues: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
    documents(includeArchived: Boolean = false): [Document!]!
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
  Review request for an issue (PRB-205).
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

  type ReviewConnection {
    nodes: [Review!]!
    pageInfo: PageInfo!
  }

  enum InitiativeState {
    PLANNED
    ACTIVE
    COMPLETED
    CANCELED
  }

  """
  Workspace initiative that groups projects (PRB-206).
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
    Completed / total issues in the initiative's projects.
    """
    progress: Float!
    completedIssues: Int!
    totalIssues: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
    documents(includeArchived: Boolean = false): [Document!]!
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
    issues(first: Int = 50, after: String): IssueConnection!
    """
    History of narrative updates (PRB-207).
    """
    updates: [ProjectStatusUpdate!]!
    documents(includeArchived: Boolean = false): [Document!]!
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
  Narrative project update (status, risks, and next steps).
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
    workspaceId: ID!
    teamId: ID
    createdAt: DateTime!
  }

  type Milestone {
    id: ID!
    name: String!
    description: String
    targetDate: DateTime
    position: Float!
    project: Project!
    issues(first: Int = 100, after: String): IssueConnection!
    """
    Completed issues divided by total issues (0..1).
    """
    progress: Float!
    createdAt: DateTime!
  }

  input TeamCreateInput {
    name: String!
    key: String!
    description: String
    visibility: TeamVisibility
    accessPolicy: TeamAccessPolicy
  }

  input TeamUpdateInput {
    name: String
    description: String
    visibility: TeamVisibility
    accessPolicy: TeamAccessPolicy
    """
    Must be a state in the Team.
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
    scopes: [ApiKeyScope!]
    teamIds: [ID!]
    expiresAt: DateTime
  }

  input ApiKeyRotateInput {
    name: String
    scopes: [ApiKeyScope!]
    teamIds: [ID!]
    expiresAt: DateTime
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
    Plaintext key. Returned once; only its hash is stored.
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
    Omit to create a Workspace label.
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
    Number of issues from which the label was removed.
    """
    affectedIssues: Int!
  }

  type WorkflowStateDeletePayload {
    success: Boolean!
    """
    Issues moved to the destination state.
    """
    movedIssues: Int!
  }

  input IDComparator {
    eq: ID
    neq: ID
    in: [ID!]
    nin: [ID!]
    """
    true: the field is NULL; false: the field is not NULL.
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
  Composable filter: fields combine with AND; and/or nest sub-filters.
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
    Full-text search over the title and description.
    """
    search: String
    """
    Issues followed by (or not followed by) the authenticated actor.
    """
    subscribed: Boolean
    """
    true: open issues with all blockers closed (frontier); false: issues with at least one open blocker.
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
    Sets the identifier number (for imports); default: automatic numbering.
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
    Labels to apply at creation (avoids an extra issueUpdate).
    """
    labelIds: [ID!]
    """
    Original creation date (imports); default: now.
    """
    createdAt: DateTime
    """
    Original author (imports); default: the API key actor.
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
    Replaces the complete set of labels.
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
    Accepts a UUID or readable identifier (AT-126).
    """
    issueId: ID!
    relatedIssueId: ID!
    """
    Type from the perspective of issueId; normalized when stored.
    """
    type: IssueRelationType!
  }

  type IssueRelationPayload {
    success: Boolean!
    relation: IssueRelation!
  }

  input CommentCreateInput {
    """
    Accepts a UUID or readable identifier (AT-126).
    """
    issueId: ID!
    body: String!
    """
    Original date (imports); default: now.
    """
    createdAt: DateTime
    """
    Original author (imports); default: the API key actor.
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
    Project Teams; omit = all current Teams (compatibility behavior).
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
    Replaces the complete set of project Teams.
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
    Omit to generate automatically; returned once.
    """
    secret: String
    """
    Subscribed events; omit for all events ("*").
    """
    events: [String!]
    teamId: ID
  }

  type WebhookPayload {
    success: Boolean!
    webhook: Webhook!
    """
    Secret used to sign deliveries. Save it; it is not shown again.
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
    Number of issues left without a milestone.
    """
    orphanedIssues: Int!
  }

  enum SavedViewScope {
    PERSONAL
    TEAM
    WORKSPACE
  }

  """
  Saved view: reusable filters, ordering, and grouping (PRB-201).
  """
  type SavedView {
    id: ID!
    name: String!
    scope: SavedViewScope!
    team: Team
    owner: Actor!
    """
    Serialized IssueFilter (JSON).
    """
    filter: JSON!
    orderBy: IssueOrder!
    """
    UI grouping criterion: state | milestone | assignee | priority.
    """
    groupBy: String!
    """
    Visible list columns (field IDs).
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
    Actor authenticated by the API key in the Authorization header.
    """
    viewer: Actor!
    workspace: Workspace!
    """
    Workspaces accessible to the current Actor and credential.
    """
    workspaces: [Workspace!]!
    teams(includeArchived: Boolean = false): [Team!]!
    team(id: ID, key: String, includeArchived: Boolean = false): Team
    actors(type: ActorType): [Actor!]!
    actorInvitations(includeRevoked: Boolean = false): [ActorInvitation!]!
    teamMemberships(teamId: ID!): [TeamMembership!]!
    """
    Accepts a UUID or readable identifier (AT-126).
    """
    issue(id: ID!): Issue
    issues(
      filter: IssueFilter
      first: Int = 50
      after: String
      orderBy: IssueOrder = CREATED_DESC
    ): IssueConnection!
    """
    Labels visible to a Team (Workspace + Team labels); without a Team, all labels.
    """
    labels(team: ID): [Label!]!
    projects(state: ProjectState, team: ID, includeArchived: Boolean = false): [Project!]!
    project(id: ID!): Project
    webhooks: [Webhook!]!
    """
    Views visible to the viewer. With teamId: Team + Workspace + personal views.
    """
    savedViews(teamId: ID, includeArchived: Boolean = false): [SavedView!]!
    savedView(id: ID!): SavedView
    favorites: [Favorite!]!
    """
    Events relevant to the authenticated actor (assignments and comments on their issues).
    """
    inbox(first: Int = 50, includeArchived: Boolean = false): [InboxItem!]!
    inboxPage(first: Int = 50, after: String, includeArchived: Boolean = false): InboxConnection!
    inboxUnreadCount: Int!
    cycles(teamId: ID!, includeArchived: Boolean = false): [Cycle!]!
    cycle(id: ID!): Cycle
    """
    Viewer review queue (as reviewer or requester).
    """
    reviews(
      openOnly: Boolean = false
      first: Int = 50
      after: String
      teamId: ID
      projectId: ID
      reviewerId: ID
      olderThanDays: Int
    ): ReviewConnection!
    review(id: ID!): Review
    initiatives(includeArchived: Boolean = false): [Initiative!]!
    initiative(id: ID!): Initiative
    documents(
      issueId: ID
      projectId: ID
      teamId: ID
      initiativeId: ID
      cycleId: ID
      search: String
      includeArchived: Boolean = false
    ): [Document!]!
    document(id: ID!): Document
  }

  type WorkspaceCreatePayload {
    success: Boolean!
    workspace: Workspace!
  }

  type Mutation {
    workspaceCreate(input: WorkspaceCreateInput!): WorkspaceCreatePayload!
    workspaceUpdate(input: WorkspaceUpdateInput!): WorkspacePayload!
    teamArchive(id: ID!): TeamPayload!
    teamUnarchive(id: ID!): TeamPayload!
    teamDelete(id: ID!, confirmation: String!): DeletePayload!
    teamCreate(input: TeamCreateInput!): TeamPayload!
    teamUpdate(id: ID!, input: TeamUpdateInput!): TeamPayload!
    teamMembershipCreate(input: TeamMembershipCreateInput!): TeamMembershipPayload!
    teamMembershipDelete(id: ID!): DeletePayload!
    actorCreate(input: ActorCreateInput!): ActorPayload!
    actorUpdate(id: ID!, input: ActorUpdateInput!): ActorPayload!
    actorInvite(input: ActorInviteInput!): ActorInvitationPayload!
    actorInvitationAccept(
      token: String!
      input: ActorInvitationAcceptInput!
    ): ActorInvitationAcceptPayload!
    actorInvitationRevoke(id: ID!): ActorInvitationRevokePayload!
    actorSuspend(id: ID!): ActorPayload!
    actorReactivate(id: ID!): ActorPayload!
    actorRevoke(id: ID!): ActorPayload!
    actorLeave(id: ID): ActorPayload!
    apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!
    apiKeyRotate(id: ID!, input: ApiKeyRotateInput!): ApiKeyPayload!
    apiKeyDelete(id: ID!): DeletePayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
    workflowStateUpdate(id: ID!, input: WorkflowStateUpdateInput!): WorkflowStatePayload!
    """
    Deletes the state; moveToStateId is required when it has issues.
    """
    workflowStateDelete(id: ID!, moveToStateId: ID): WorkflowStateDeletePayload!
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!
    issueArchive(id: ID!): IssuePayload!
    issueUnarchive(id: ID!): IssuePayload!
    issueSubscribe(id: ID!): IssuePayload!
    issueUnsubscribe(id: ID!): IssuePayload!
    labelCreate(input: LabelCreateInput!): LabelPayload!
    labelUpdate(id: ID!, input: LabelUpdateInput!): LabelPayload!
    labelDelete(id: ID!): LabelDeletePayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    issueRelationCreate(input: IssueRelationCreateInput!): IssueRelationPayload!
    issueRelationDelete(id: ID!): DeletePayload!
    documentCreate(input: DocumentCreateInput!): DocumentPayload!
    documentUpdate(id: ID!, input: DocumentUpdateInput!): DocumentPayload!
    documentArchive(id: ID!): DocumentPayload!
    documentUnarchive(id: ID!): DocumentPayload!
    projectCreate(input: ProjectCreateInput!): ProjectPayload!
    projectUpdate(id: ID!, input: ProjectUpdateInput!): ProjectPayload!
    projectArchive(id: ID!): ProjectPayload!
    projectUnarchive(id: ID!): ProjectPayload!
    milestoneCreate(input: MilestoneCreateInput!): MilestonePayload!
    milestoneUpdate(id: ID!, input: MilestoneUpdateInput!): MilestonePayload!
    """
    Deletes the milestone; assigned issues are left without a milestone.
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
    Moves open issues from the source cycle to the destination cycle.
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
