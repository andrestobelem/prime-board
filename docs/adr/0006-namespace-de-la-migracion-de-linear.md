# Namespace de la migración de Linear

**Estado:** aceptada

## Contexto

El Team de Linear usa la clave `AT`. El board local histórico de prime-board también generó Identifiers `AT-*`, pero no siempre representan las mismas Issues. El relevamiento encontró colisiones. Por ejemplo, `AT-185` tiene títulos distintos en Linear y en el repositorio local. Si el importador resolviera solo por Identifier, sobrescribiría trabajo o mezclaría historiales.

## Decisión

1. **Los Identifiers de Linear conservan la clave `AT`** durante la migración. Ya aparecen en repositorios, documentos y enlaces externos.
2. Las Issues propias de prime-board que no estén en el export de Linear pasan a un Team separado con clave **`PRB`** (`prime-board dev`). El equipo conserva el número cuando es posible y actualiza las referencias `AT-*` de snapshots, Logs, documentos y enlaces.
3. Las Issues de demo (`PB`) no forman parte de la migración. Permanecen como datos descartables de demostración.
4. El importador mantiene un mapa de origen `Linear UUID → prime-board Identifier` y nunca resuelve entidades solo por título o nombre.

## Alcance de la reclasificación local

Las 26 Issues locales que coinciden con el proyecto histórico de Linear pueden conservar su Identifier `AT-*`. Las Issues locales con títulos distintos y las creadas solo en prime-board deben cambiar a `PRB-*` antes del corte.

## Consecuencias

- Los enlaces externos a Issues de Linear siguen funcionando después de la migración.
- Los documentos históricos de desarrollo de prime-board necesitan actualizar sus referencias. No deben reinterpretarlas en silencio.
- El Team `AT` final representa el backlog migrado de Linear. `PRB` representa el desarrollo de prime-board.
- Una migración parcial que no incluya el mapa de origen o el cambio de clave es inválida.

## Rechazado

- Importar Linear con otra clave rompería referencias públicas ya distribuidas.
- Sobrescribir las Issues locales por coincidencia de `AT-*` perdería historial y evidencia del desarrollo de prime-board.
