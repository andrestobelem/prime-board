# Triage Labels

Las skills hablan de cinco roles canónicos de triage. En prime-board esos roles
son **estados del workflow**, no labels: son posiciones mutuamente excluyentes del
ciclo de vida de un issue, y el board ya los modelaba así.

| Rol en mattpocock/skills | En nuestro tracker (estado del team AT) | Significado |
| --- | --- | --- |
| `needs-triage` | **Needs Triage** (tipo `triage`) | Hay que evaluar el issue |
| `needs-info` | **Needs Info** (tipo `unstarted`) | Esperando información de quien reportó |
| `ready-for-agent` | **Ready for Agent** (tipo `unstarted`) | Especificado, listo para un agente AFK |
| `ready-for-human` | **Ready for Human** (tipo `unstarted`) | Requiere implementación humana |
| `wontfix` | **Canceled** (tipo `canceled`) | No se va a accionar |

Cuando una skill menciona un rol ("apply the AFK-ready triage label"), **cambiar el
estado del issue** al de la columna del medio:

```bash
pb issue update AT-172 --state "Ready for Agent"
```

Los tipos semánticos (`triage`, `unstarted`, `canceled`) permiten filtrar sin
conocer los nombres: `pb issue list --team AT --state triage --json`.
