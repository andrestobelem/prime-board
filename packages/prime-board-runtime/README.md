# @prime-board/runtime

Runtime distribuible de prime-board. La versión 0.1 requiere Bun y se construye desde el
monorepo con `bun run build`; el launcher aislado por repositorio y los binarios standalone
se implementan en tickets posteriores.

```bash
bun run build
bun dist/cli.js --db /tmp/prime-board.db --repo /ruta/al/proyecto --port 3333
```

La base operativa queda fuera del package y `--repo` configura la Repository Replica del
proyecto. No guardes API keys ni secretos en el package o en `.prime-board/`.
