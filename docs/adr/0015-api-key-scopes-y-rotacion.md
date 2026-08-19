# ADR 0015: scopes, límites y rotación de API keys

- **Estado:** Aceptado
- **Contexto:** PRB-380

## Decisión

Cada API key conserva el Actor al que pertenece y, opcionalmente, una allowlist de Teams.
Los scopes son `READ`, `WRITE` y `ADMIN`, con jerarquía `ADMIN > WRITE > READ`.
Un scope solo reduce las capacidades del Actor: nunca convierte a un miembro en
Workspace Admin ni crea memberships. Las operaciones administrativas siguen
exigiendo `workspaceRole = ADMIN`.

Una key sin `teamIds` está limitada al Workspace completo por compatibilidad. Una
lista no otorga membresías y exige que todos los Teams de un recurso multi-Team
estén incluidos. Las queries sin frontera determinista se rechazan para keys
limitadas, en lugar de filtrar silenciosamente resultados.

`resolveAuth` rechaza antes de actualizar `lastUsedAt` las keys revocadas,
expiradas o pertenecientes a Actors inactivos. La rotación inserta la reemplazante
y revoca la anterior en una transacción; el secreto en claro se devuelve una sola
vez. Una key solo puede crear o rotar descendientes dentro de su propio ceiling de
scopes y Teams.

## Persistencia y réplica

La migración 0020 guarda expiración, relación de rotación, scopes y límites por
Team. Los exports guardan únicamente metadata no secreta (nunca plaintext,
hashes ni secretos de webhook). Un rebuild conserva hashes disponibles en la DB
local; cuando solo existe metadata del repositorio, crea una credencial redacted,
no utilizable, para no perder el contrato de scopes/expiración. Los límites se
remapean por `Team.key`, nunca por IDs regenerables.

## Superficies

GraphQL es la autoridad; CLI (`pb api-key create|list|rotate|delete`), MCP y la
vista Members exponen scopes, Teams y expiración. Ninguna superficie imprime un
hash ni vuelve a mostrar un secreto después de la creación o rotación.
