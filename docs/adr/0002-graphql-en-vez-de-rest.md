# GraphQL en vez de REST

La API pública de Linear usa GraphQL y prime-board es un clon de Linear para agentes. Esta paridad conceptual permite que un agente que ya opera Linear opere prime-board. También permite que el MCP server exponga las mismas 14 tools que el MCP de Linear.

Las queries flexibles sirven al consumidor principal. Un agente puede pedir exactamente los campos que necesita sin varios round-trips ni endpoints específicos.

Si alguien propone REST, debe resolver primero el costo de compatibilidad. Romper la paridad con Linear elimina el principal atajo de adopción del producto.
