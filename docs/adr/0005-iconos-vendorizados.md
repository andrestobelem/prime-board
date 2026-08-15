# Los íconos de la UI se vendorizan, no se instalan como dependencia

`apps/web/src/components/icons.tsx` tiene los paths SVG inline, copiados de Lucide (ISC) y
con su atribución en el encabezado, en vez de depender de `lucide-react`.

Se midió: los íconos que la UI usa pesan **1,9 KB gzip** vendorizados contra 3,2 KB del
paquete más ~40 MB en `node_modules`. Y hay tres íconos que Lucide no tiene con el lenguaje
visual de Linear —`in-progress` (círculo con sector tipo torta), `no-priority` (tres guiones)
y `urgent` (cuadrado redondeado con `!`)— que están dibujados a mano sobre el mismo grid de
24×24: con la librería quedarían como un caso aparte, vendorizados conviven sin costura.

Esto es una desviación deliberada del camino obvio: **no "arreglar" esto instalando
`lucide-react`**. El costo aceptado es que actualizar un ícono es copiar un path a mano.
