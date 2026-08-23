# Estados de triage

Las skills usan cinco roles canónicos de triage. En prime-board esos roles son **estados del workflow**, no labels. Son posiciones mutuamente excluyentes del ciclo de vida de una Issue y el board ya los modela de esta forma.

| Rol en mattpocock/skills | En nuestro tracker (estado del Team PRB) | Significado                                           |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| `needs-triage`           | **Needs Triage** (tipo `triage`)         | Hay que evaluar la Issue                              |
| `needs-info`             | **Needs Info** (tipo `unstarted`)        | Falta información de quien reportó                    |
| `ready-for-agent`        | **Ready for Agent** (tipo `unstarted`)   | La Issue está especificada y lista para un agente AFK |
| `ready-for-human`        | **Ready for Human** (tipo `unstarted`)   | Requiere implementación humana                        |
| `wontfix`                | **Canceled** (tipo `canceled`)           | No se realizará la acción                             |

Cuando una skill mencione un rol, como `apply the AFK-ready triage label`, cambia el estado de la Issue al valor de la columna central:

```bash
pb issue update PRB-172 --state "Ready for Agent"
```

Los estados operativos (`Backlog`, `In Progress`, `Ready for Review` y `Done`) describen el trabajo. Los estados de triage describen la decisión previa y no sustituyen el ciclo operativo. `Ready for Human` significa que una persona debe implementar o decidir; `Ready for Review` significa que una entrega espera una verificación independiente.

`Ready for Review` es un estado operativo y no un rol de triage. Un agente usa ese estado después de dejar una entrega con SHA, criterios, verificación y brechas. El reviewer mueve la Issue a `Done` o la devuelve a `In Progress`.

Los tipos semánticos (`triage`, `unstarted`, `canceled`) permiten filtrar sin conocer los nombres visibles:

```bash
pb issue list --team PRB --state triage --json
```
