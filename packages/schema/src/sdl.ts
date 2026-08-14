// SDL del esquema GraphQL de prime-board (docs/specs/mvp.md §4).
// Crece por partes: AT-132 base, AT-133 teams/actores, AT-134+ issues, etc.
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum ActorType {
    HUMAN
    AGENT
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

  type Query {
    """Actor autenticado por la API key del header Authorization."""
    viewer: Actor!
    workspace: Workspace!
  }
`;
