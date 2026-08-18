# Procedimiento de corte Linear → prime-board

Este procedimiento se ejecuta solamente después de validar una captura completa de
Linear. Hasta entonces, Linear sigue siendo la fuente operativa y no se deben
actualizar las instrucciones de agentes.

## Resultado ejecutado

El corte se ejecutó el 2026-08-16 con `docs/migrations/linear-export-2026-08-16.json`:

- 36 issues Linear, 17 comentarios, 119 eventos, 0 conflictos y 0 pérdidas no aprobadas.
- Los 26 issues locales equivalentes conservaron `AT-*`; 50 issues locales colisionados fueron
  rekeyeados a `PRB-*` y el mapa quedó persistido en `migration-report.json`.
- El resultado contiene 86 issues, 71 comentarios y 619 eventos al reconstruir SQLite.
- `--check` devolvió `pendingCreates: []`, `conflicts: []`, `countMismatches: []` y
  `contentMismatches: []`.
- El warning de estado `Duplicate` se conserva explícitamente como `canceled` con su nombre.

El commit inmediatamente anterior al corte fue `ab55efd`; el backup de `.prime-board/` se
conservó antes de reemplazarlo. La base local se creó/reconstruyó desde el resultado y se
verificó con la suite completa.

## Precondiciones

1. Guardar la captura original de Linear en almacenamiento inmutable. No modificarla.
2. Confirmar que contiene UUIDs de origen para todas las entidades y que `parseLinearExport`
   no produce conflictos de referencias.
3. Ejecutar el dry-run y revisar `conflicts`, `losses`, `countMismatches` y
   `contentMismatches`. No usar `--allow-losses` salvo que cada pérdida esté aprobada.
4. Crear un backup del repo operativo, de SQLite y de la captura.
5. Poner Linear en modo de lectura para la ventana de verificación.

## Generar el resultado reversible

```bash
bun run import:linear \
  --from /backups/linear-export.json \
  --merge-local /ruta/prime-board \
  --out /ruta/prime-board-cutover \
  --json

bun run import:linear \
  --from /backups/linear-export.json \
  --check /ruta/prime-board-cutover \
  --json

bun run typecheck
bun test
```

El merge nunca muta el repo de entrada. Linear conserva el namespace `AT`; los issues
locales equivalentes se mantienen en `AT` y los demás se rekeyean a `PRB`. El mapa queda
en `meta/migration-report.json` y `meta/source-map.json`.

Tras la revisión humana, reconstruir SQLite desde el resultado con `--apply`, levantar
prime-board y verificar que un agente pueda listar, asignar, comentar, relacionar y cerrar
issues. Conservar tanto la captura como el directorio de resultado antes de eliminar el
backup.

## Actualizar la operación

Solo después de la verificación post-corte:

- cambiar `AGENTS.md` para que el team operativo nuevo sea `PRB`;
- actualizar `docs/agents/issue-tracker.md`, skills, MCP y CLI para no crear issues en Linear;
- indicar explícitamente que Linear es archivo de consulta;
- documentar el enlace entre los issues importados `AT-*` y sus UUIDs de origen.

## Rollback

1. Detener prime-board y bloquear escrituras.
2. Restaurar el commit/directorio y la copia SQLite anteriores al corte.
3. Verificar que el `source-map` y la captura inmutable sigan intactos.
4. Reabrir Linear solo para corregir datos durante una nueva ventana controlada.
5. Repetir dry-run, reconciliación y revisión antes de un nuevo corte.

El rollback no borra ni modifica issues de Linear: la migración es una operación de
exportación hacia un output nuevo y reversible.
