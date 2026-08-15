# Local-first single-tenant, con API keys hasheadas y sin OAuth

El modelo de uso es un proceso local con **un** workspace, corriendo donde corre el agente.
No hay multi-tenancy, ni organizaciones, ni OAuth: la autenticación es una API key por actor
(`pb_<random>`, guardada como hash SHA-256), y el primer arranque siembra el workspace, el
team default y un actor admin con su key.

Esto es lo que permite que un agente arranque el board sin infraestructura ni cuentas, y es
la misma premisa que sostiene ADR-0001. El costo aceptado: no hay recuperación de una key
perdida (se emite una nueva), y cualquier despliegue compartido exigiría rehacer la capa de
auth entera.
