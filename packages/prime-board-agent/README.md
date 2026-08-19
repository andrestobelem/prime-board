# `@prime-board/agent`

Package mínimo de [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) para
prime-board. Distribuye una extensión de discovery/status y la skill
`prime-board-workflow`; no inicia el runtime, configura credenciales ni modifica la réplica
`.prime-board/`.

## Instalación local

Desde el checkout de prime-board:

```bash
prime-agent package install ./packages/prime-board-agent --local
```

También se puede instalar desde npm o Git cuando exista un release del paquete.

## Extensión

La extensión registra:

- `/prime-board`: descubre el root Git del proyecto y comprueba `GET /health`.
- `prime_board_status`: la misma comprobación como herramienta del agente.

La URL se toma de `PRIME_BOARD_URL` o usa `http://localhost:3333`. La comprobación es
read-only y no arranca procesos; el launcher y la configuración del runtime siguen siendo
responsabilidad del proyecto.

## Skill

Invoca `/skill:prime-board-workflow` para el flujo operativo: activar la instancia aislada,
buscar y reclamar Issues, implementar y validar, dejar evidencia y resolver. Las credenciales
(`PRIME_BOARD_API_KEY`) deben permanecer fuera del package y del repositorio.
