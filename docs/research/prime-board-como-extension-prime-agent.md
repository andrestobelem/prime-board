# Cómo empaquetar prime-board como extensión de prime-agent

> Investigación para PRB-422. Fecha: 2026-08-19 (snapshot histórico).\
> Snapshot local de la investigación: `prime-agent 0.7.3`, `bun 1.3.14`, prime-board en `main`.\
> Verificación del runtime local: 2026-08-23, base `8899e11` (`main`) y cambios locales.

## Conclusión ejecutiva

La integración es viable, pero **no como un plugin binario único**. Prime Agent distribuye **Prime Agent packages** por npm, Git o una ruta local. El package puede contener una extensión TypeScript, skills Markdown/Python, prompts y themes.

Para prime-board, separa tres capas:

1. **Package de Prime Agent (`@prime-board/agent`)**: extensión que descubre el repositorio, levanta o verifica el runtime local, registra comandos/tools de control y carga la skill de workflow.
2. **Runtime distribuible de prime-board**: servidor GraphQL + web estática + backend SQLite predeterminado;
   PostgreSQL es opcional y su migración es incremental. Debe distribuirse como fuente ejecutable con Bun o,
   preferentemente, como binario standalone por plataforma.
3. **Adaptador de capacidades**: mantener GraphQL como autoridad y reutilizar los dos transportes MCP actuales según el cliente. `apps/mcp/src/index.ts` ofrece MCP por stdio; `apps/mcp/src/http.ts` ofrece MCP por Streamable HTTP local en `/mcp`. Prime Agent puede integrar el transporte HTTP mediante `McpIntegration`, pero no conecta el servidor stdio local desde `mcpServers`.

La propuesta de package conserva una instancia por repositorio, una DB aislada y la réplica `.prime-board/`
existente. El runtime SQLite actual ya permite varias Workspaces con selección y aislamiento incremental.
El backend PostgreSQL mantiene un singleton, por lo que el package debe declarar el backend y no prometer
multi-Workspace fuera de SQLite. Sus paths directos cubren Actors, autenticación, API keys y límites de Team,
Teams, Issues, Relations, Projects, Milestones, Cycles, Labels, Documents, Activity, suscriptores, Reviews,
Initiatives, Project Updates, Saved Views, Favorites, Inbox y Webhooks. Relations está implementado por
PRB-437 y API keys/límites por PRB-552. Comments no tiene persistencia PostgreSQL; el event log canónico de
ADR-0019 tampoco forma parte de este runtime.

## Qué soporta oficialmente Prime Agent

La instalación local documenta estos puntos de extensión:

| Mecanismo                | Sirve para                                                                      | Evaluación para prime-board                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **TypeScript extension** | Eventos, tools del LLM, comandos, UI TUI, estado persistente, providers y gates | **Sí**: lifecycle del server, `/prime-board`, `status`, `open`, health-check y tools de control.      |
| **Markdown skill**       | Instrucciones progresivas, workflows, scripts y referencias                     | **Sí**: instalar, autenticar, reclamar tickets, validar, comentar y resolver.                         |
| **Python-backed skill**  | Código callable en el kernel IPython                                            | **Sí** para un cliente GraphQL/MCP programático; requiere probar instalación en el kernel gestionado. |
| **MCP integration**      | Skill Python basada en `McpIntegration`                                         | **Sí, si el servidor es HTTP**. Prime Agent no conecta servidores stdio locales desde `mcpServers`.   |
| **Package**              | Transporte npm/Git/local de extensiones, skills, prompts y themes               | **Sí**: es la unidad oficial de distribución.                                                         |
| **SDK/RPC/ACP**          | Integrar Prime Agent como aplicación o proceso externo                          | No es el formato de recursos que necesitamos para instalar prime-board.                               |

Prime Agent no define un contrato separado llamado `plugin` ni carga plugins nativos o binarios. La extensión TypeScript es el equivalente más cercano a un plugin in-process.

### Manifest mínimo del package

```json
{
  "name": "@prime-board/agent",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["extensions", "skills", "prompts", "runtime", "README.md", "LICENSE"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

Instalación global o por proyecto:

```bash
prime-agent package install npm:@prime-board/agent@0.1.0
prime-agent package install git:github.com/andrestobelem/prime-board@vX --local
prime-agent package install ./prime-board-agent --local
```

`--local` escribe `.prime/agent/settings.json`, que puede versionarse. El package no debe escribir secretos ni `mcpServers` en su manifest.

## Inventario verificable de prime-board

| Componente                                  | Ubicación actual                                                                                                       | Qué necesita el bundle                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Servidor GraphQL, webhooks y static serving | `apps/server`                                                                                                          | Runtime Bun, migraciones, schema y dependencias de producción.                                                                                                                                                                                                                                                                     |
| Schema compartido                           | `packages/schema`                                                                                                      | Debe entrar en el build del server/CLI/MCP; hoy usa `workspace:*`.                                                                                                                                                                                                                                                                 |
| SQLite                                      | `bun:sqlite` en `apps/server/src/db/database.ts`                                                                       | Backend predeterminado; Bun obligatorio para ejecutar fuente; aplica migraciones SQLite `0001`–`0028`.                                                                                                                                                                                                                             |
| PostgreSQL                                  | `Bun.SQL`, `apps/server/src/db/postgres/`                                                                              | Backend opcional; migrador independiente `0001`–`0010`, singleton de Workspace y cobertura incremental. `0010` agrega `projector_checkpoints` para checkpoints durables del projector. Paths directos incluyen Issues, Relations, API keys y límites. Comments y la proyección completa del event log canónico siguen fuera de PG. |
| UI                                          | `apps/web`, salida `apps/web/dist` ignorada por Git                                                                    | Build previo y assets incluidos; el server sirve `index.html` y `/assets`.                                                                                                                                                                                                                                                         |
| CLI                                         | `apps/cli`, bin privado `pb`                                                                                           | Empaquetar entrypoint/runtime o reemplazarlo por un `prime-board` bin público.                                                                                                                                                                                                                                                     |
| MCP                                         | `apps/mcp/src/index.ts` (`StdioServerTransport`) y `apps/mcp/src/http.ts` (`WebStandardStreamableHTTPServerTransport`) | stdio funciona para clientes locales; Streamable HTTP escucha en `127.0.0.1:3334/mcp` por defecto y es el transporte compatible con `McpIntegration`.                                                                                                                                                                              |
| Launcher                                    | `scripts/prime-board-project.ts`                                                                                       | Reutilizar la lógica por repositorio, pero convertirla en lifecycle de la extensión.                                                                                                                                                                                                                                               |
| DB operativa                                | `PRIME_BOARD_DB`, default `~/.prime-board/prime-board.db`                                                              | Mantenerla fuera del package, idealmente `~/.prime-board/projects/<slug-hash>.db`.                                                                                                                                                                                                                                                 |
| Réplica                                     | `PRIME_BOARD_REPO` → `<repo>/.prime-board/`                                                                            | Mantenerla en el proyecto; escribir solo mediante API/CLI, nunca desde el package directamente.                                                                                                                                                                                                                                    |
| Configuración de clientes                   | `PRIME_BOARD_URL`, `PRIME_BOARD_API_KEY`, `PRIME_BOARD_PROFILE`                                                        | Resolver por proceso y nunca persistir en settings de Prime Agent como texto plano.                                                                                                                                                                                                                                                |
| Skills del proyecto                         | `.agents/skills/prime-board-workflow`                                                                                  | Reempaquetar o enlazar como `skills/prime-board-workflow`.                                                                                                                                                                                                                                                                         |

El server importa las 28 migraciones SQLite como texto durante el build. El migrador PostgreSQL importa
diez migraciones independientes. `0010` agrega `projector_checkpoints`; `0008` y `0009` conservan el Workspace de los límites de Team de API keys
y hacen explícito el grant del Workspace efectivo (PRB-552). Esta separación favorece un binario compilado,
pero el package debe seleccionar y validar el backend. La web se resuelve mediante `PRIME_BOARD_WEB_DIST`/`apps/web/dist`;
el package debe tratar de forma explícita los assets empaquetados.

### Estado actual de los transportes MCP

- **stdio**: `apps/mcp/src/index.ts` conecta `createServer` con `StdioServerTransport`. Requiere un cliente
  que ejecute el proceso local y le entregue `PRIME_BOARD_URL` y `PRIME_BOARD_API_KEY` en su entorno.
- **Streamable HTTP**: `apps/mcp/src/http.ts` conecta los mismos handlers con
  `WebStandardStreamableHTTPServerTransport`. Expone `/mcp` en `127.0.0.1:3334` por defecto, recibe la
  API key como bearer por request y mantiene sesiones stateful con `mcp-session-id`.
- **Límite en Prime Agent**: la integración `McpIntegration` puede consumir una URL HTTP con bearer, pero
  no inicia ni consume el proceso stdio local desde `mcpServers`. HTTP resuelve el transporte, no el
  bootstrap del runtime, el descubrimiento de URL ni el almacenamiento seguro de credenciales.

## Arquitectura recomendada

```text
Prime Agent
  └── package @prime-board/agent
      ├── extensions/index.ts
      │   ├── detecta git root desde ctx.cwd
      │   ├── ensureRuntime(repoRoot)
      │   ├── /prime-board status|open|logs|stop
      │   └── prime_board_status / prime_board_open
      ├── skills/prime-board-workflow/SKILL.md
      ├── skills/prime-board-api/              # opcional Python-backed
      ├── prompts/prime-board.md
      └── runtime/
          ├── bin/<platform>/prime-board       # fase productiva
          └── web/                              # si no se embebe en el binario

DB:       ~/.prime-board/projects/<project-hash>.db
Replica:  <git-root>/.prime-board/
Server:   127.0.0.1:<allocated-port>
Auth:     ~/.prime-board/credentials/<project-hash>.json (0600)
```

### Responsabilidad de la extensión

- En `session_start`, encontrar el root Git de `ctx.cwd` y ejecutar un health-check.
- Adquirir un lock por proyecto antes de iniciar el server; varias sesiones de Prime Agent no deben levantar dos SQLite/procesos para la misma réplica.
- Iniciar el runtime con `spawn` y argumentos, nunca interpolando el path en un shell.
- Elegir un puerto libre o añadir soporte de `--port 0` con endpoint/archivo de descubrimiento atómico.
- Esperar `/health` antes de exponer tools; mostrar una instrucción accionable si falta Bun/binario o la DB no puede abrirse.
- Exponer solo comandos/tools pequeños de lifecycle y diagnóstico. Las operaciones de issues deben seguir por GraphQL/MCP/CLI, no por un tool genérico que acepte comandos shell arbitrarios.
- En `session_shutdown`, liberar la referencia del proceso, pero no matar un server que otra sesión sigue usando. Un idle timeout y un PID/lock verificable son más seguros que un `kill` incondicional.
- Ofrecer `/prime-board open` para abrir la UI en el navegador; no intentar incrustar la aplicación React completa en la TUI.

### Cómo exponer las operaciones al modelo

**Opción preferida: integrar el MCP Streamable HTTP local existente.**

1. Reutilizar los handlers de `apps/mcp/src/server.ts`.
2. Iniciar `apps/mcp/src/http.ts`, que ya expone `/mcp` mediante Streamable HTTP.
3. Configurar una skill Python con `McpIntegration` y `server = "prime-board"` usando la URL HTTP y el bearer de la API key.
4. La extensión arranca o comprueba el server MCP y configura/descubre URL y credencial; la skill enumera tools con `list_tools()`.

Esta opción conserva la cobertura del MCP existente, evita duplicar resolvers en TypeScript y sigue el patrón de Linear/Notion de Prime Agent. El transporte HTTP actual escucha solo en `127.0.0.1` (puerto predeterminado `3334`, ruta `/mcp`), autentica cada request con bearer y conserva sesiones MCP con revalidación de la API key. El package todavía debe resolver el lifecycle y la entrega segura de la credencial; el endpoint no convierte el servidor stdio en una integración compatible.

**Alternativa de prototipo: tools TypeScript directas.**

La extensión puede usar `pi.registerTool()` y hacer `fetch` a `/graphql`. Es suficiente para `status`, `list_issues` y `save_issue`, pero replicar toda la superficie del MCP en la extensión crea dos contratos que después pueden divergir. No recomiendo un único `prime_board_graphql(query, variables)` para el modelo: es potente, pero poco descubrible y aumenta el riesgo de mutaciones no intencionadas.

**Alternativa de transición: skill Markdown + CLI.**

Reutiliza `pb` mediante Bash y requiere menos código, pero depende de que Bun/source estén instalados y no se siente como una capacidad integrada. Sirve como ruta de transición o compatibilidad cuando el cliente no puede usar el MCP HTTP actual.

## Distribución del runtime

### A. Fuente + Bun (prototipo)

El package contiene el runtime fuente y exige Bun instalado:

```text
prime-board-agent/
  runtime-source/
  extensions/
  skills/
```

Ventaja: rápida y transparente en desarrollo. Desventajas: Bun no forma parte de las garantías de Prime Agent, el monorepo usa `workspace:*` y los paquetes son privados, y la instalación productiva con npm no reproduce `bun install` automáticamente.

### B. Binario standalone por plataforma (recomendado)

Bun soporta compilar un entrypoint TypeScript/JavaScript en un ejecutable standalone que contiene una copia del runtime Bun (`bun build ... --compile`), y permite incrustar assets con `--asset`. El pipeline debe generar al menos `darwin-arm64`, `darwin-x64`, `linux-x64` y `win32-x64` si son plataformas objetivo.

Ejemplo conceptual:

```bash
bun build ./apps/server/src/index.ts \
  --compile \
  --outfile ./runtime/bin/prime-board-$TARGET \
  --asset ./apps/web/dist
```

Antes de adoptarlo hay que adaptar el server para localizar de forma portable la UI embebida, fijar `hostname=127.0.0.1`, comprobar el tamaño/licencia de artefactos y probar migraciones, WAL y signals en cada plataforma.

Ventaja: Prime Agent solo necesita ejecutar un binario. Desventajas: artefactos grandes, matriz de releases, firma/notarización y empaquetado de assets por plataforma.

### C. Servicio remoto/hosted

No uses esta opción para este objetivo: cambia local-first, añade auth/operación y no resuelve la réplica Git por proyecto. También queda fuera de la decisión multi-Workspace vigente.

## Seguridad y datos

- Los packages y extensiones de Prime Agent ejecutan código con permisos del sistema. Instalar un package equivale a confiar en él.
- El server local debe bindear explícitamente a `127.0.0.1` y exigir bearer en GraphQL/MCP; solo `/health` puede ser anónimo.
- API keys y secrets de Webhooks deben vivir fuera del package y de `.prime-board/`, con permisos `0600`.
- El path del repositorio puede contener espacios o caracteres especiales: usar `spawn(command, argv, { cwd, env })`, nunca `sh -c`.
- La réplica `.prime-board/` se genera vía API/CLI; el package no debe editarla a mano.
- Una sesión de Prime Agent, una skill Python y una extensión no constituyen un sandbox: heredan permisos del usuario y pueden tocar la DB/repo.
- El primer bootstrap imprime una API key una sola vez. El instalador debe capturarla de forma controlada o proveer un flujo explícito para crear una key de agente; nunca ponerla en `settings.json`, logs públicos ni commits.
- El paquete debe fijar versiones y verificar integridad de binarios; `prime-agent package update` no debe actualizar automáticamente una migración de DB sin backup/rollback.

## Plan por fases

### Fase 0 — prueba de concepto sin cambiar prime-board

- Crear un package local npm/git con manifest `pi`.
- Incluir la skill `prime-board-workflow` y una extensión que solo haga health-check/start del server existente.
- Requerir Bun y una ruta explícita al checkout de prime-board.
- Validar `prime-agent package install ./... --local`, `/reload`, dos sesiones y un proyecto con espacios en el path.

### Fase 1 — runtime instalable

- Extraer el runtime público y dejar de depender de `workspace:*`/paquetes `private`.
- Añadir comando de runtime para `--project`, `--db`, `--port`, `--host`, `--web-dist`, `--print-env` y `--status`.
- Fijar bind local, descubrimiento de puerto, lock y shutdown.
- Producir binarios standalone y assets reproducibles; testear migraciones, `/health`, UI y réplica.

### Fase 2 — integración nativa de capacidades

- Integrar el endpoint `/mcp` Streamable HTTP local ya implementado en `apps/mcp/src/http.ts`; si el cliente no puede usarlo, mantener una skill Python GraphQL versionada como alternativa.
- Mantener GraphQL como autoridad; cubrir read/write/admin y errores estables.
- Crear una identidad de agente y credential storage por proyecto con permisos estrictos.
- Añadir tests de aislamiento entre dos proyectos y de no exposición de secretos.

### Fase 3 — release y actualización

- Publicar `@prime-board/agent` y los runtimes con versionado coordinado.
- Smoke test en una instalación limpia de Prime Agent por plataforma.
- `prime-agent package update` actualiza recursos; una migración de DB requiere backup, chequeo de versión y rollback documentado.
- No anunciar multi-Workspace para el backend PostgreSQL hasta completar la selección y el aislamiento
  multi-Workspace. Memberships, grants y límites de Team de API keys ya tienen paths PostgreSQL, pero el
  backend conserva un singleton. El runtime SQLite ya expone esa capacidad de forma incremental; el package
  debe indicar cuál backend usa.

## Matriz de decisión

| Alternativa                              | Tiempo inicial | UX agente                   | Dependencias            | Mantenimiento       | Decisión            |
| ---------------------------------------- | -------------: | --------------------------- | ----------------------- | ------------------- | ------------------- |
| Skill Markdown + source checkout         |           Bajo | Media                       | Bun + repo              | Bajo                | Prototipo           |
| Extension + tools GraphQL                |          Medio | Alta para pocas operaciones | Bun/runtime             | Alto si replica MCP | Transición          |
| Extension + MCP HTTP + skill Python      |     Medio/alto | Alta y cobertura MCP        | Runtime + kernel Python | Medio               | **Recomendada**     |
| Package + binarios standalone + MCP HTTP |           Alto | Alta, instalación limpia    | Binarios por plataforma | Medio/alto          | Objetivo productivo |
| Hosted service                           |           Alto | Alta                        | Infra/auth              | Alto                | Fuera de alcance    |

## Preguntas abiertas

1. ¿“Todo prime-board” incluye también la UI de navegador, o solo la capacidad agent-facing GraphQL/CLI/MCP?
2. ¿La DB debe ser estrictamente por repositorio (modelo actual) o habrá una instancia global del usuario?
3. ¿Qué plataformas se soportan en la primera release: macOS arm64, macOS x64, Linux x64, Windows x64?
4. ¿Aceptamos exigir Bun para la primera versión o el objetivo requiere binarios standalone desde el comienzo?
5. ¿El paquete será público en npm, privado o distribuido por Git?
6. ¿La autenticación inicial la hace el humano con la key de admin o el instalador debe crear/configurar automáticamente un Actor Agent?
7. ¿El endpoint Streamable HTTP actual cubre la integración prevista con Prime Agent, o basta una skill GraphQL específica como alternativa?

## Fuentes primarias

### Prime Agent

- [Packages](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/packages.md): manifest `pi`, npm/Git/local install, paths, dependencies, filters y scopes.
- [Extensions](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/extensions.md): `ExtensionAPI`, tools, commands, events, UI y seguridad.
- [Skills](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md): Markdown/Python-backed, discovery y kernel.
- [MCP integrations](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/mcp-integrations.md): `McpIntegration`, auth, HTTP y limitación stdio.
- [Package source commit consultado](https://github.com/PrimeIntellect-ai/prime-agent/commit/36307ca40d62a9af339702082be9b644a652b6cc): snapshot del documento de packages.

### Prime-board local

- [`README.md`](../../README.md): quick start, launcher por proyecto, CLI, MCP stdio/Streamable HTTP y réplica.
- [`apps/server/src/config.ts`](../../apps/server/src/config.ts): `PRIME_BOARD_*`, DB, webDist y repo.
- [`apps/server/src/server.ts`](../../apps/server/src/server.ts): GraphQL, static UI, health y proceso Bun.
- [`apps/server/src/db/database.ts`](../../apps/server/src/db/database.ts): `bun:sqlite`, WAL, migraciones SQLite `0001`–`0028` y foreign keys.
- [`apps/server/src/db/postgres/migrator.ts`](../../apps/server/src/db/postgres/migrator.ts): migraciones PostgreSQL `0001`–`0010` y checksums; `0010` crea `projector_checkpoints`.
- [`apps/server/src/config.ts`](../../apps/server/src/config.ts): backend predeterminado SQLite y selección opcional de PostgreSQL.
- [`scripts/prime-board-project.ts`](../../scripts/prime-board-project.ts): DB por proyecto, hash de ruta y `PRIME_BOARD_REPO`.
- [`apps/cli/package.json`](../../apps/cli/package.json), [`apps/mcp/package.json`](../../apps/mcp/package.json) y [`apps/server/package.json`](../../apps/server/package.json): paquetes privados/workspace actuales; MCP publica los entrypoints `pb-mcp` (stdio) y `pb-mcp-http` (Streamable HTTP).
- [`apps/mcp/src/index.ts`](../../apps/mcp/src/index.ts): `StdioServerTransport` actual.
- [`apps/mcp/src/http.ts`](../../apps/mcp/src/http.ts): `WebStandardStreamableHTTPServerTransport` actual, endpoint `/mcp`, bearer y sesiones locales.
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): catálogo de tools MCP reutilizable.
- [`apps/mcp/src/api.ts`](../../apps/mcp/src/api.ts): configuración bearer y sesión de Workspace actual.

### Bun

- [Bundler / standalone executables](https://bun.sh/docs/bundler): `--compile` y `--asset`.
- [SQLite](https://bun.sh/docs/runtime/sqlite): API `bun:sqlite` usada por el servidor.

## Regla de actualización

Actualiza este documento si cambia la API de packages/extensions/MCP de Prime Agent, si prime-board publica
un runtime instalable, cambia el backend predeterminado o cambia la implementación o integración de los
transportes MCP stdio/Streamable HTTP. La extensión no es una frontera de seguridad. Empaquetar el runtime
tampoco habilita multi-Workspace en PostgreSQL.
