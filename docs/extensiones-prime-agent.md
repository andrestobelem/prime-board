# Extensión `question` de Prime Agent

La extensión [`examples/extensions/question.ts`](../examples/extensions/question.ts) registra la herramienta `question`. La herramienta permite que el agente presente una pregunta con opciones, agregue `Type something.` para una respuesta libre y reciba la respuesta como resultado.

## Cargar la extensión

Para probarla en una sesión puntual:

```bash
prime-agent --extension ./examples/extensions/question.ts
```

Para instalarla como extensión autodetectada del usuario:

```bash
mkdir -p ~/.prime/agent/extensions
cp examples/extensions/question.ts ~/.prime/agent/extensions/
```

## Comportamiento

- `Enter` selecciona la opción resaltada.
- `↑` y `↓` recorren las opciones.
- `Esc` cancela el diálogo actual.
- `Type something.` abre un segundo diálogo de texto; `Enter` confirma la respuesta.
- En modos sin UI, la herramienta devuelve un error explícito en vez de bloquear la sesión.
- La extensión usa `ctx.ui.select()` y `ctx.ui.input()`. Ambas funciones también son compatibles con el modo daemon.

`ctx.ui.custom()` no está disponible en el binding daemon de Prime Agent. Por eso la extensión usa dos diálogos estándar encadenados.
