# ADR-0021: contrato OAuth 2.0 mínimo para agentes

- Estado: propuesto, pendiente de aprobación en PRB-603
- Fecha: 2026-09-08
- Issue: PRB-603
- Alcance: contrato futuro para PRB-387; no cambia el runtime actual

## Contexto

prime-board usa API keys como autenticación API-first. El modo local-first actual no
ofrece OAuth. ADR-0003 y ADR-0017 dejan OAuth fuera del corte operativo, y PRB-603
pide fijar el contrato antes de considerar una implementación.

PRB-444 y PRB-581 pertenecen al flujo de Webhooks. Fijan reglas de ownership,
Team limits, secretos y el identificador de los eventos PostgreSQL. No son una
base para compartir tablas, secretos o dispatcher con OAuth. OAuth debe conservar
la misma frontera de Workspace y Team, pero debe tener su propio ciclo de vida.

Este ADR propone un perfil pequeño de OAuth 2.0 para clientes públicos usados por
agentes. La propuesta no agrega endpoints ni tablas al runtime, no aprueba todavía
los scopes y no incorpora un proveedor externo ni paridad con Linear. Los nombres
de endpoints y operaciones que siguen describen el contrato propuesto, no una
superficie implementada. La autorización del Actor en un navegador y cualquier
sesión hosteada son un prerrequisito separado. Este ADR no crea un mecanismo de
login.

## Decisión propuesta

### Perfil soportado

El primer perfil soporta solamente:

- Authorization Code Grant (`response_type=code`).
- PKCE obligatorio con `code_challenge_method=S256`.
- Clientes públicos. No se emite `client_secret` en este perfil.
- Scopes `read` y `write`. `write` incluye `read`, igual que la jerarquía actual
  de API keys. No existe el scope OAuth `admin`.
- Access tokens opacos de tipo Bearer para el API GraphQL de prime-board.
- Refresh tokens con rotación y detección de reutilización.
- Revocación RFC 7009 y revocación administrativa del Grant.

Quedan fuera del perfil el flujo implícito, Resource Owner Password Credentials,
Client Credentials, Device Authorization Grant, OIDC, UserInfo, JWT, introspection,
dynamic client registration, SSO/SCIM y DPoP. Añadir un cliente confidencial o un
método de autenticación distinto requiere otro ADR.

La excepción es documental: ADR-0003 y ADR-0017 siguen describiendo el runtime
actual. La aceptación de este ADR permite planificar una implementación hosteada,
pero no la habilita.

### Aplicaciones y registro

Una `OAuthApplication` es una aplicación registrada dentro de un Workspace. No es
un Actor y no recibe permisos por sí misma. Tiene, como mínimo, esta metadata:

- `id` interno y `client_id` público, aleatorio y no reutilizable.
- `name` para mostrar en el consentimiento.
- `workspace_id` inmutable.
- `owner_actor_id`.
- `client_type = public`.
- `redirect_uris` validadas.
- `allowed_scopes`, que debe ser un subconjunto no vacío de `{read, write}`.
  `write` incluye `read` por la jerarquía de scopes.
- `team_ids` opcional para limitar el alcance de Team.
- `status`, con `active` o `revoked`, y fechas de creación y revocación.

El `client_id` no es un secreto. El perfil público no tiene `client_secret`. Por
lo tanto, nunca se debe aceptar un `client_secret` como si fuera una prueba de
identidad de este tipo de cliente.

La operación de registro propuesta es GraphQL:

```text
oauthApplicationCreate(input: {
  name,
  redirectUris,
  allowedScopes,
  teamIds
})
```

El Workspace efectivo proviene del `WorkspaceContext` autenticado. No se toma de
un `workspaceId` enviado por el caller. El registro requiere un Actor `active` y
una credencial existente con capacidad de escritura. El owner puede administrar
sus aplicaciones. Un Workspace Admin puede administrar cualquier aplicación del
Workspace. Ningún Actor puede registrar una aplicación en otro Workspace.

Las operaciones administrativas propuestas son `oauthApplications`,
`oauthApplicationUpdate`, `oauthApplicationRevoke`, `oauthGrants` y
`oauthGrantRevoke`. Deben devolver metadata, nunca códigos, tokens, hashes ni
secretos. `oauthApplicationUpdate` revoca los Grants de la aplicación cuando
cambia `redirectUris`, `allowedScopes` o `teamIds`. Así no quedan Grants con una
política de registro anterior.

El registro aplica estos límites:

- Debe existir al menos una URI y como máximo diez URIs por aplicación.
- Cada URI tiene como máximo 2048 bytes.
- No se aceptan URI con fragmento, comodines, `userinfo` ni redirecciones a una
  URI construida por el caller.
- `allowedScopes` solo acepta `read` y `write`, sin valores desconocidos ni
  duplicados.
- Cada Team de `teamIds` debe pertenecer al Workspace de la aplicación. Una
  lista vacía no agrega un límite de Team; la autorización normal del Actor
  sigue aplicándose.

El estado de una aplicación no es una fuente de autorización. El token siempre
se evalúa contra el Actor activo, su Workspace Membership, los controles de Team
y el Grant vigente.

### Redirect URI

La aplicación debe enviar `redirect_uri` tanto a `/oauth/authorize` como a
`/oauth/token`. El servidor compara la cadena completa con una URI registrada.
No acepta prefijos, comodines, coincidencia por dominio, redirecciones abiertas,
fragmentos ni cambios de esquema, host, puerto, path o query.

El primer perfil admite:

- URI HTTPS con una URI completa registrada.
- URI HTTP solo para loopback con puerto fijo registrado. El host debe ser
  `127.0.0.1` o `[::1]`.

No admite `localhost`, URI de esquema privado ni puertos dinámicos en este corte.
El puerto dinámico de loopback de RFC 8252 requiere una regla de registro distinta
a la comparación exacta. Se deja para otra decisión para no mezclar dos políticas.

Si `redirect_uri` falta o no coincide, el servidor responde `400` sin redirigir al
user-agent. Nunca envía un código o un error a una URI no validada. El endpoint
solo se publica sobre HTTPS, aun si el redirect de loopback usa HTTP.

### Flujo de autorización

El cliente abre el navegador externo con una solicitud como esta:

```text
GET /oauth/authorize?
  response_type=code&
  client_id=CLIENT_ID&
  redirect_uri=REGISTERED_URI&
  scope=read%20write&
  state=CLIENT_STATE&
  code_challenge=BASE64URL_SHA256(CODE_VERIFIER)&
  code_challenge_method=S256
```

Los parámetros son obligatorios en este perfil: `response_type=code`, `client_id`,
`redirect_uri`, `scope`, `state`, `code_challenge` y
`code_challenge_method=S256`. `scope` no tiene un valor por defecto. Esta regla
impide que una aplicación obtenga más permisos por una omisión del caller.

El endpoint resuelve el Workspace desde la aplicación. Resuelve el Actor desde
una sesión autenticada del user-agent y exige una Workspace Membership `active`.
El flujo no acepta una API key en la query, en la URI de redirect ni en un
parámetro de sesión inventado. Este ADR no define el mecanismo de login de esa
sesión.

El servidor calcula los permisos efectivos en este orden:

1. La solicitud debe pedir solo scopes conocidos.
2. La solicitud debe ser un subconjunto de `allowed_scopes` de la aplicación,
   aplicando la jerarquía en la que `write` permite también `read`.
3. El servidor debe eliminar cualquier capacidad que el Actor no tenga en el
   Workspace y en los Teams solicitados.
4. El resultado no puede incluir `admin`. Si no queda ningún scope, el servidor
   rechaza la solicitud.

El consentimiento muestra el nombre de la aplicación, el Workspace, el Actor
que recibirá el acceso, los scopes efectivos y los límites de Team. La aprobación
crea un `OAuthGrant` asociado a un único Actor, Workspace y aplicación. El Grant
conserva los scopes efectivos y los `team_ids` de la aplicación. Un Grant nunca
hereda acceso de otro Workspace.

El `state` se devuelve sin cambios en una respuesta válida o en una denegación.
El servidor solo lo incluye después de validar `redirect_uri`. El cliente debe
comparar el `state` antes de procesar el código.

El código de autorización es opaco, aleatorio y válido durante 60 segundos. Se
almacena solo su hash y queda ligado a:

- `client_id` y `redirect_uri` exactos;
- Actor y Workspace efectivos;
- scopes y límites de Team del Grant;
- `code_challenge` y el método `S256`.

El servidor marca el código como consumido dentro de la misma transacción que
valida su intercambio. Un segundo uso, incluso concurrente, falla con
`invalid_grant` y revoca cualquier token que ya se hubiera creado a partir del
código.

### PKCE

El cliente genera un `code_verifier` nuevo para cada autorización. Debe usar de 43
a 128 caracteres de la gramática de RFC 7636. El servidor exige `S256`; no acepta
`plain` ni omisión del método. El token endpoint calcula:

```text
BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) == code_challenge
```

Un challenge no se reutiliza entre transacciones. Un challenge inválido produce
`invalid_grant` sin indicar si el código existe, expiró o fue usado. El verifier
no se registra ni aparece en logs.

### Intercambio y access token

El endpoint es:

```text
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
```

Para `grant_type=authorization_code`, el cliente público envía `client_id`,
`code`, `redirect_uri` y `code_verifier`. El servidor verifica el vínculo exacto
entre aplicación, código, redirect, Workspace y PKCE.

La respuesta exitosa usa `200`, JSON, `Cache-Control: no-store` y `Pragma:
no-cache`:

```json
{
  "access_token": "opaque-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "opaque-refresh-token",
  "scope": "read write"
}
```

El access token dura una hora. Es aleatorio, opaco, específico para el API de
prime-board y se almacena solo como hash. No se emiten JWT ni tokens con datos del
Workspace en claro. El caller lo envía solo en el header:

```text
Authorization: Bearer ACCESS_TOKEN
```

Al resolverlo, el API crea un `AuthContext` con el Actor, Workspace, scopes,
límites de Team y origen OAuth. Cada request vuelve a comprobar:

- que el token no esté revocado ni expirado;
- que el Grant y la aplicación estén activos;
- que el Actor siga `active` en el Workspace;
- que la Membership, Team Visibility, Team Access Policy y límites del Grant
  permitan la operación.

El token no convierte un `member` en Admin. Una operación administrativa sigue
rechazada aunque el Actor administre el Workspace, porque OAuth no emite el
scope `admin`. Un `X-Workspace-ID` que contradiga el Workspace del Grant falla
con `UNAUTHORIZED`; el caller no puede cambiar el Workspace efectivo con un
header.

### Refresh token y lifecycle

El refresh token también es opaco, aleatorio y se almacena solo como hash. Cada
familia de refresh tokens tiene un `family_id`, un Grant, un vencimiento absoluto
de 30 días y el vínculo con su token anterior y siguiente. No hay renovación
indefinida por actividad.

Para `grant_type=refresh_token`, el cliente envía `client_id` y
`refresh_token`. Puede pedir un subconjunto de los scopes actuales, nunca una
ampliación. Si omite `scope`, conserva los scopes actuales. El servidor vuelve a
comprobar el Actor, la Membership, la aplicación, el Grant y los límites de Team.

Cada refresh válido hace todo lo siguiente en una única transacción:

1. marca el refresh token recibido como usado;
2. crea un nuevo access token;
3. crea un nuevo refresh token de la misma familia;
4. conserva la relación anterior/siguiente;
5. limita la nueva expiración al vencimiento absoluto de la familia.

El refresh token anterior no vuelve a ser válido. Si se recibe un refresh token
usado, revocado o de una familia que ya detectó reutilización, el servidor revoca
la familia completa, sus access tokens y el Grant. Responde `invalid_grant` sin
indicar qué token fue detectado. La transacción usa una condición de uso único,
por lo que dos refresh concurrentes no pueden producir dos hijos válidos.

El vencimiento, la suspensión o la salida del Actor, la pérdida de la Membership,
la revocación de la aplicación y la revocación del Grant invalidan los tokens al
resolver cada request. Revocar una API key no revoca por sí sola un Grant OAuth:
son credenciales separadas. Revocar al Actor o su acceso al Workspace sí invalida
sus Grants en ese Workspace.

### Revocación

El endpoint estándar es:

```text
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded
```

Acepta `token` y el `token_type_hint` opcional con `access_token` o
`refresh_token`. El cliente público envía también `client_id`. La revocación debe
ser inmediata para el API y debe invalidar toda la familia y el Grant asociado,
no solo el string presentado. Esto incluye access tokens emitidos por la familia.

El endpoint responde `200` tanto para un token válido como para uno desconocido,
expirado o ya revocado. No revela si el token existió. Un error de formato,
client_id inexistente o fallo temporal puede usar los errores estándar de OAuth,
pero no debe incluir secretos ni datos del Grant.

La operación GraphQL `oauthGrantRevoke` permite revocar un Grant al Actor dueño
del Grant o a un Workspace Admin. La operación `oauthApplicationRevoke` permite
al owner de la aplicación o a un Workspace Admin revocar la aplicación y todos
sus Grants. Todas estas operaciones exigen que el recurso pertenezca al Workspace
efectivo; un ID de otro Workspace no revela su existencia.

### Secretos, almacenamiento y límites de seguridad

Los siguientes valores se tratan como secretos de credencial:

- authorization codes;
- access tokens;
- refresh tokens;
- `code_verifier` y `state` mientras están en el cliente;
- cualquier futuro `client_secret`, si otro ADR lo autoriza.

El servidor genera los tres tokens con un CSPRNG y al menos 256 bits. Guarda solo
hashes de los valores de alta entropía. No escribe valores en logs, traces,
excepciones, métricas, fixtures, exports, `.prime-board`, snapshots ni backups
operativos de la réplica. Las respuestas de token y revocación usan
`Cache-Control: no-store`; las páginas de autorización usan una política de
referer que no filtre parámetros. Los valores de callback deben limpiarse de la
URL del navegador después de procesarlos.

No se cifra un token para luego volver a mostrarlo. El servidor no necesita
recuperar el valor original. El cliente recibe cada valor secreto una sola vez.

El perfil usa estos límites de lifecycle:

| Credencial         | Límite                           | Regla adicional                                            |
| ------------------ | -------------------------------- | ---------------------------------------------------------- |
| Authorization code | 60 segundos                      | un uso, ligado a client, redirect, Actor, Workspace y PKCE |
| Access token       | 3600 segundos                    | Bearer opaco, revocable, solo para el API de prime-board   |
| Refresh token      | máximo 30 días por familia       | rotación por uso y revocación por reutilización            |
| Scopes             | `read`, `write`                  | `write` incluye `read`; nunca `admin`                      |
| Team limits        | los Teams del `OAuthApplication` | se intersectan con la autorización actual del Actor        |

La implementación debe aplicar rate limits separados para autorización, token y
revocación por client, Actor e IP. Los valores de capacidad y de despliegue no
forman parte de este contrato, pero el servidor debe fallar de forma segura si
ese control no está disponible. Todas las rutas OAuth rechazan métodos, medios,
parámetros desconocidos o cuerpos por encima del límite configurado sin registrar
su contenido.

### Errores estables

Los endpoints OAuth usan el cuerpo JSON de RFC 6749, sección 5.2:

```json
{
  "error": "invalid_grant"
}
```

No se exige `error_description`. Si se incluye para diagnóstico de cliente, no
puede distinguir existencia, expiración, revocación o owner de un código o token.
Los códigos de este perfil son:

| Código                      | Uso                                                                        |
| --------------------------- | -------------------------------------------------------------------------- |
| `invalid_request`           | falta un parámetro obligatorio o tiene una forma inválida                  |
| `invalid_client`            | client authentication enviada para un tipo no soportado o inválida         |
| `unauthorized_client`       | la aplicación no puede usar el flujo solicitado                            |
| `unsupported_response_type` | `response_type` distinto de `code`                                         |
| `unsupported_grant_type`    | grant type distinto de `authorization_code` o `refresh_token`              |
| `invalid_scope`             | scope desconocido, no permitido por la aplicación o sin capacidad efectiva |
| `access_denied`             | el Actor rechazó el consentimiento                                         |
| `invalid_grant`             | código, PKCE, redirect, refresh, Grant o familia inválidos                 |
| `unsupported_token_type`    | `token_type_hint` no soportado                                             |

Un error de autorización se redirige solo a la URI previamente validada y lleva
`error` y el `state` exacto. Un redirect inválido, un client desconocido o un
request imposible no se redirige. Token endpoint y revocation endpoint devuelven
JSON y nunca redirect.

Las operaciones GraphQL de administración reutilizan los códigos actuales:
`UNAUTHORIZED`, `NOT_FOUND` y `VALIDATION_FAILED`. Las requests al API con un
Bearer inválido o sin permiso devuelven `UNAUTHORIZED`, sin exponer el motivo
interno. Esto mantiene una respuesta estable con API keys y evita que OAuth cree
un bypass de los guards existentes.

## Threat model y controles

| Amenaza                                      | Control del contrato                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Interceptar un código en el callback         | PKCE S256 por transacción y código de un solo uso                                               |
| Inyectar un código o cambiar la aplicación   | código ligado a client, redirect, Actor, Workspace y verifier                                   |
| Abrir un redirector o robar un callback      | URI completa registrada, sin wildcard, sin fragmento y sin redirect de error a URI inválida     |
| Reusar un refresh robado                     | rotación, vínculo de familia, detección atómica y revocación de toda la familia                 |
| Usar un access token robado por mucho tiempo | token opaco, TLS obligatorio, TTL de una hora y revocación inmediata                            |
| Elevar permisos con `scope`                  | intersección de request, aplicación, Actor, Membership, Team y API guards; sin `admin`          |
| Cruzar Workspaces                            | aplicación, código, Grant y AuthContext ligados a un Workspace; selector no confiable rechazado |
| Usar una Membership revocada                 | comprobación del estado del Actor y Membership en cada request                                  |
| Filtrar credenciales por logs o réplica      | hashes en DB, `no-store`, exclusión de logs, fixtures, exports y `.prime-board`                 |
| Enumerar códigos, tokens o Grants            | `invalid_grant` genérico, revocación idempotente con `200` y `NOT_FOUND` scoped                 |
| Registrar un callback peligroso              | validación al crear y actualizar la aplicación, con límites de URI y host                       |

## Regresiones requeridas para una implementación futura

La implementación de PRB-387 no puede considerarse lista sin cubrir, como mínimo:

1. rechazo de `admin`, scopes desconocidos y scopes fuera de
   `allowed_scopes`;
2. rechazo de un scope que el Actor o su Membership no pueda ejercer;
3. rechazo de redirect con prefijo, host, puerto, path, query, fragmento o
   esquema diferente;
4. rechazo de PKCE ausente, `plain`, verifier inválido o verifier de otra
   transacción;
5. expiración y replay de authorization code, incluido replay concurrente;
6. un solo refresh válido en una carrera y revocación de la familia al reutilizar
   el refresh anterior;
7. revocación con access token, refresh token, Grant, aplicación, Actor
   suspendido y Membership terminada;
8. rechazo de una selección de Workspace que no coincide con el Grant;
9. enforcement de Team limits en lecturas, mutaciones y recursos multi-Team;
10. ausencia de secretos en logs, errores, fixtures, exports y snapshots.

Estas regresiones son criterios de implementación posterior. PRB-603 entrega el
contrato, no las tablas ni sus pruebas de runtime.

## Consecuencias

El contrato mantiene la autenticación API-first y reutiliza el modelo vigente de
Actor, Workspace Membership, Team Access Policy, scopes y límites de Team. Un
agente puede obtener una credencial de duración corta y renovarla sin guardar una
API key administrativa.

El costo es una nueva sesión de consentimiento y un almacenamiento sensible
separado de API keys y Webhooks. La rotación de refresh tokens exige una
transacción atómica y retener vínculos de familia. El perfil no ofrece una
protección de prueba de posesión para access tokens; por eso usa TTL corto,
revocación y TLS. Añadir DPoP o clientes confidenciales requiere validar el
modelo de despliegue hosteado en otro ADR.

## Referencias

- [PRB-603](../../.prime-board/issues/PRB-603.md)
- [PRB-387](../../.prime-board/issues/PRB-387.md)
- [PRB-444](../../.prime-board/issues/PRB-444.md)
- [PRB-581](../../.prime-board/issues/PRB-581.md)
- [ADR-0003, local-first y API keys](0003-local-first-single-tenant.md)
- [ADR-0008, autorización de Actors y API keys](0008-autorizacion-de-actors-y-api-keys.md)
- [ADR-0013, frontera de autorización de Workspace](0013-frontera-de-autorizacion-de-workspace.md)
- [ADR-0015, scopes, límites y rotación de API keys](0015-api-key-scopes-y-rotacion.md)
- [ADR-0016, visibilidad y política de Teams](0016-visibilidad-y-politica-de-teams.md)
- [ADR-0017, multi-Workspace](0017-multi-workspace-compartido.md)
- [RFC 6749, OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749),
  secciones 3.1.2.3, 4.1.2 a 4.1.4 y 5.2.
- [RFC 7636, PKCE](https://www.rfc-editor.org/rfc/rfc7636), secciones 4.3, 4.5 y 4.6.
- [RFC 8252, OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252),
  secciones 6, 7.3 y 8.1.
- [RFC 7009, Token Revocation](https://www.rfc-editor.org/rfc/rfc7009), secciones 2.1 y 2.2.
- [RFC 9700, OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700),
  secciones 2.1.1, 2.2.2 y 4.14.
