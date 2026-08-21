# La UI incluye sus íconos; no instala una dependencia

`apps/web/src/components/icons.tsx` contiene los paths SVG inline copiados de Lucide (ISC), con la atribución en el encabezado. La UI no depende de `lucide-react`.

Medimos el peso de los íconos que usa la UI: **1,9 KB gzip** cuando están incluidos en el proyecto, frente a 3,2 KB del paquete y unos 40 MB en `node_modules`. Además, Lucide no ofrece tres íconos con el lenguaje visual de Linear: `in-progress` (círculo con sector), `no-priority` (tres guiones) y `urgent` (cuadrado redondeado con `!`). Los tres usan el mismo grid de 24×24 y conviven con los paths copiados.

Esta es una desviación deliberada: **no instales `lucide-react` para corregirla**. El costo aceptado es copiar a mano un path cuando se actualiza un ícono.
