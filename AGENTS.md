# Guía para agentes

## Misión

prime-board es un clon de Linear para agentes: un gestor de issues/proyectos pensado
para que lo usen agentes (en principio prime-agent, aunque debería poder usarse con otros).

## Gestión del trabajo

- Los tickets viven en Linear, proyecto **prime-board** del workspace `andrestobelem`:
  https://linear.app/andrestobelem/project/prime-board-f7456b6a57b3
- Todo trabajo nuevo se anota como ticket ahí antes de implementarse.

## Idioma

- **En español:** documentación, comentarios de código, tickets, specs, skills,
  mensajes de commit y todo lo demás.
- **En inglés:** la aplicación en sí (código, identificadores, mensajes de la app,
  API pública) y todo lo que sea parte de ella.

## Commits

- Conventional commits **con scope**: `tipo(scope): descripción`
  (ej.: `feat(api): agrega endpoint de issues`).
- Commits **atómicos**: un cambio lógico por commit.
- **Nunca** usar atribuciones `Co-authored-by` ni similares.

## Estructura

- `docs/` — documentación del proyecto (specs, relevamientos, decisiones).
- `scratchpad/` — trabajo temporal; está ignorada por git.

## Skills

Las skills del repo viven en **`.agents/skills/`** y se traen con el Skills CLI
(catálogo en https://skills.sh):

```bash
npx skills add <paquete> --agent universal --copy
```

- `--agent universal` es el target que escribe en `.agents/` (la convención genérica,
  no atada a un agente concreto). **No usar `--agent "*"`**: instala en ~50 directorios
  distintos (`.claude`, `.cursor`, `.windsurf`, …) y ensucia el repo.
- `--copy` guarda copias reales en vez de symlinks, para que las skills viajen con el
  repo y funcionen en cualquier clon.
- `skills-lock.json` queda versionado; `npx skills experimental_install` restaura desde ahí.
- Las skills corren con permisos del agente: revisarlas antes de usarlas.
