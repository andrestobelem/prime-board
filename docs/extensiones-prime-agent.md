# Extensión `question` de Prime Agent

La extensión [`examples/extensions/question.ts`](../examples/extensions/question.ts)
registra la herramienta `question`. Permite que el agente presente una pregunta
con opciones, agregue la opción `Type something.` para una respuesta libre y
reciba el resultado como respuesta de la herramienta.

## Cargarla

Para probarla en una sesión puntual:

```bash
prime-agent --extension ./examples/extensions/question.ts
```

También puede instalarse como extensión autodetectada para el usuario:

```bash
mkdir -p ~/.prime/agent/extensions
cp examples/extensions/question.ts ~/.prime/agent/extensions/
```

## Comportamiento

- `Enter` selecciona la opción resaltada.
- `↑` y `↓` navegan por las opciones.
- `Esc` cancela el diálogo actual.
- `Type something.` abre un segundo diálogo de texto; `Enter` confirma la respuesta.
- En modos sin UI, la herramienta devuelve un error explícito en vez de bloquearse.
- Usa `ctx.ui.select()` y `ctx.ui.input()`, compatibles también con el modo daemon.

La UI personalizada (`ctx.ui.custom()`) no está disponible en el binding daemon de
Prime Agent, por eso la extensión usa dos diálogos estándar encadenados.
