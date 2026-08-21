# Procedimiento de corte Linear → prime-board

Ejecuta este procedimiento solo después de validar una captura completa de Linear. Hasta entonces, Linear sigue siendo la fuente operativa y el equipo no debe actualizar las instrucciones de los agentes.

## Resultado ejecutado

El equipo ejecutó el corte el 2026-08-16 con `docs/migrations/linear-export-2026-08-16.json`:

- 36 Issues de Linear, 17 Comments, 119 eventos, 0 conflictos y 0 pérdidas no aprobadas.
- Las 26 Issues locales equivalentes conservaron `AT-*`. El equipo cambió a `PRB-*` las 50 Issues locales colisionadas y persistió el mapa en `migration-report.json`.
- El resultado contiene 86 Issues, 71 Comments y 619 eventos al reconstruir SQLite.
- `--check` devolvió `pendingCreates: []`, `conflicts: []`, `countMismatches: []` y `contentMismatches: []`.
- El sistema conserva explícitamente el warning de estado `Duplicate` como `canceled` con su nombre.

El commit inmediatamente anterior al corte fue `ab55efd`. El equipo conservó el backup de `.prime-board/` antes de reemplazarlo. Creó o reconstruyó la base local desde el resultado y la verificó con la suite completa.

## Precondiciones

1. Guarda la captura original de Linear en almacenamiento inmutable. No la modifiques.
2. Confirma que contiene UUIDs de origen para todas las entidades y que `parseLinearExport` no produce conflictos de referencias.
3. Ejecuta el dry-run y revisa `conflicts`, `losses`, `countMismatches` y `contentMismatches`. No uses `--allow-losses` hasta aprobar cada pérdida.
4. Crea un backup del repositorio operativo, de SQLite y de la captura.
5. Pon Linear en modo de lectura durante la ventana de verificación.

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

El merge nunca muta el repositorio de entrada. Linear conserva el namespace `AT`. Las Issues locales equivalentes permanecen en `AT` y las demás cambian a `PRB`. El mapa queda en `meta/migration-report.json` y `meta/source-map.json`.

Después de la revisión humana, reconstruye SQLite desde el resultado con `--apply`. Levanta prime-board y verifica que un agente pueda listar, asignar, comentar, relacionar y cerrar Issues. Conserva la captura y el directorio de resultado antes de eliminar el backup.

## Actualizar la operación

Solo después de la verificación post-corte:

- cambia `AGENTS.md` para que el nuevo Team operativo sea `PRB`;
- actualiza `docs/agents/issue-tracker.md`, las skills, MCP y CLI para que no creen Issues en Linear;
- indica explícitamente que Linear es un archivo de consulta;
- documenta el enlace entre las Issues importadas `AT-*` y sus UUIDs de origen.

## Rollback

1. Detén prime-board y bloquea las escrituras.
2. Restaura el commit/directorio y la copia SQLite anteriores al corte.
3. Verifica que `source-map` y la captura inmutable sigan intactos.
4. Reabre Linear solo para corregir datos durante una nueva ventana controlada.
5. Repite dry-run, reconciliación y revisión antes de un nuevo corte.

El rollback no borra ni modifica Issues de Linear. La migración exporta hacia un output nuevo y reversible.
