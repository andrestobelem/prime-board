# Documentación del dominio

Cómo deben consumir las skills de ingeniería la documentación del dominio al explorar el código.

## Lectura inicial

Antes de explorar, lee uno de estos archivos:

- **`CONTEXT.md`** en la raíz del repositorio; o
- **`CONTEXT-MAP.md`** en la raíz, si existe. Este archivo apunta a un `CONTEXT.md` por contexto. Lee cada contexto relacionado con el tema.
- **`docs/adr/`**. Lee los ADR que afecten el área que vas a modificar. En un repositorio con varios contextos, revisa también `src/<context>/docs/adr/` para las decisiones específicas del contexto.

Si alguno de estos archivos no existe, continúa sin informar la ausencia y sin proponer su creación. La skill `/domain-modeling` (a la que llegan `/grill-with-docs` y `/improve-codebase-architecture`) los crea de forma diferida cuando una decisión o un término del dominio lo requiere.

## Estructura de archivos

Este repositorio es **single-context**: `apps/*` y `packages/*` son capas de un mismo producto (server, web, CLI, MCP y schema), no dominios separados.

```text
/
├── CONTEXT.md          ← glosario del dominio (se crea cuando hace falta)
├── docs/adr/           ← decisiones de arquitectura
├── apps/{server,web,cli,mcp}
└── packages/schema
```

Si un paquete desarrolla su propio lenguaje de dominio, migra el repositorio a multi-context y crea un `CONTEXT-MAP.md` en la raíz. El mapa debe apuntar a un `CONTEXT.md` por contexto.

## Vocabulario del glosario

Cuando tu salida nombre un concepto del dominio (por ejemplo, en el título de un issue, una propuesta de refactor, una hipótesis o un nombre de test), usa el término definido en `CONTEXT.md`. No lo sustituyas por un sinónimo que el glosario marque como no recomendado.

Si el concepto que necesitas no aparece en el glosario, trátalo como una señal. Tal vez estás inventando un término que el proyecto no usa. Si existe una carencia real, anótala para `/domain-modeling`.

## Conflictos con ADR

Si tu salida contradice un ADR existente, informa el conflicto de forma explícita. No lo sobrescribas sin mencionarlo:

> _Contradice ADR-0007 (Memberships y alcance de Initiatives); conviene reabrirlo porque…_
