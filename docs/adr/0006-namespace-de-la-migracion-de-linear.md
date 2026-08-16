# Namespace de la migración de Linear

**Estado:** aceptada

## Contexto

El team de Linear usa la clave `AT`. El board local histórico de prime-board también
generó identificadores `AT-*`, pero no representan siempre los mismos issues. Al relevar
ambos sistemas encontramos colisiones: por ejemplo, `AT-185` tiene títulos distintos en
Linear y en el repo local. Importar por identificador sin una decisión previa sobrescribiría
trabajo o mezclaría historiales.

## Decisión

1. **Los identificadores de Linear conservan la clave `AT`** durante la migración. Son la
   referencia pública que ya aparece en repositorios, documentos y enlaces externos.
2. Los issues propios de prime-board que no estén representados por el export de Linear se
   moverán a un team separado con clave **`PRB`** (`prime-board dev`). Se conservará el
   número cuando sea posible y se actualizarán las referencias `AT-*` de sus snapshots, logs,
   documentos y enlaces.
3. Los issues de demo (`PB`) no forman parte de la migración; se mantienen como datos de
   demostración descartables.
4. El importador debe mantener un mapa de origen `Linear UUID → prime-board identifier` y
   nunca resolver entidades solo por título o nombre.

## Alcance de la reclasificación local

Los 26 issues locales que coinciden con el proyecto histórico de Linear pueden conservar su
identificador `AT-*`. Los issues locales con títulos distintos y los issues creados solo en
prime-board deben rekeyearse a `PRB-*` antes del corte.

## Consecuencias

- Los enlaces externos a issues de Linear siguen funcionando después de la migración.
- Los documentos históricos de desarrollo de prime-board requieren una actualización de
  referencias, no una reinterpretación silenciosa.
- El team `AT` final representa el backlog migrado de Linear; `PRB` representa el desarrollo
  del producto prime-board.
- Una migración parcial que no incluya el mapa de origen o el rekeying se considera inválida.

## Rechazado

- Importar Linear con otra clave: rompería referencias públicas ya distribuidas.
- Sobrescribir los issues locales por coincidencia de `AT-*`: perdería historial y evidencia
  del desarrollo de prime-board.
