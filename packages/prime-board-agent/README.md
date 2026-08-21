# `@prime-board/agent`

Paquete mínimo de [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) para
prime-board. Distribuye una extensión para descubrimiento y estado, además de la skill
`prime-board-workflow`. No inicia el runtime, configura credenciales ni modifica la réplica
`.prime-board/`.

## Instalación local

Desde el checkout de prime-board:

```bash
prime-agent package install ./packages/prime-board-agent --local
```

También puedes instalarlo desde npm o Git cuando exista un release del paquete.

## Extensión

La extensión registra:

- `/prime-board`: descubre la raíz Git del proyecto y comprueba `GET /health`.
- `prime_board_status`: expone la misma comprobación como herramienta del agente.

La extensión toma la URL de `PRIME_BOARD_URL` o usa `http://localhost:3333`. La comprobación
solo lee datos y no inicia procesos. El proyecto sigue siendo responsable del launcher y de
la configuración del runtime.

## Skill

Invoca `/skill:prime-board-workflow` para ejecutar el flujo operativo: activar la instancia
aislada, buscar y reclamar Issues, implementar y validar, dejar evidencia y resolver. Mantén
las credenciales (`PRIME_BOARD_API_KEY`) fuera del paquete y del repositorio.
