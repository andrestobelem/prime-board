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

- Las skills se instalan en el repo (a nivel proyecto) con el Skills CLI:
  `npx skills add <paquete>` (catálogo en https://skills.sh).
