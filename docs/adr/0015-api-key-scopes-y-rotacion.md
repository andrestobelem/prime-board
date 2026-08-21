# ADR-0015: Scopes, límites y rotación de API keys

- **Estado:** aceptado
- **Contexto:** PRB-380

## Decisión

Cada API key conserva el Actor al que pertenece y, de forma opcional, una allowlist de Teams. Los Scopes son `READ`, `WRITE` y `ADMIN`, con jerarquía `ADMIN > WRITE > READ`. Un Scope solo reduce las capacidades del Actor: nunca convierte a un member en Workspace Admin ni crea Memberships. Las operaciones administrativas siguen exigiendo `workspaceRole = ADMIN`.

Una key sin `teamIds` cubre todo el Workspace por compatibilidad. Una lista de Teams no otorga Memberships. Para un recurso multi-Team, la key debe incluir todos sus Teams. El sistema rechaza las queries sin frontera determinista para keys limitadas, en lugar de filtrar resultados en silencio.

`resolveAuth` rechaza, antes de actualizar `lastUsedAt`, las keys revocadas o expiradas y las pertenecientes a Actors inactivos. La rotación inserta la key reemplazante y revoca la anterior en una transacción. El sistema devuelve el secreto en claro una sola vez. Una key solo puede crear o rotar descendientes dentro de su propio ceiling de Scopes y Teams.

## Persistencia y réplica

La migración 0020 guarda expiración, relación de rotación, Scopes y límites por Team. Los exports guardan solo metadata no secreta: nunca plaintext, hashes ni secretos de webhook. Un rebuild conserva los hashes disponibles en la DB local. Cuando solo existe metadata del repositorio, crea una credencial redacted no utilizable para conservar el contrato de Scopes y expiración. El sistema remapea los límites mediante `Team.key`, nunca mediante IDs regenerables.

## Superficies

GraphQL es la autoridad. CLI (`pb api-key create|list|rotate|delete`), MCP y la vista Members exponen Scopes, Teams y expiración. Ninguna superficie imprime un hash ni vuelve a mostrar un secreto después de la creación o la rotación.
