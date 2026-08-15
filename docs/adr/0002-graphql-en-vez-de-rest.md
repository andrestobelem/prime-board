# GraphQL en vez de REST

La API pública de Linear es GraphQL, y prime-board es un clon de Linear para agentes: la
paridad conceptual hace que un agente que ya sabe operar Linear sepa operar prime-board, y
que el MCP server pueda exponer las mismas 14 tools que el MCP de Linear.

Además, las queries flexibles le sirven al consumidor principal: un agente que quiere pedir
exactamente los campos que va a usar, sin varios round-trips ni endpoints a medida.

Si alguien propone REST en el futuro, el argumento a vencer no es técnico sino de
compatibilidad: romper la paridad con Linear le quita al producto su principal atajo de
adopción.
