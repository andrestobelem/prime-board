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
- `Esc` cancela la pregunta o vuelve desde la respuesta libre a la lista.
- `Type something.` abre un editor inline; `Enter` confirma el texto.
- En modos sin UI, la herramienta devuelve un error explícito en vez de bloquearse.

La implementación usa `ctx.ui.custom()` porque el diálogo combina una lista y
un editor. Para diálogos simples, la API también expone `ctx.ui.select()` e
`ctx.ui.input()`.
