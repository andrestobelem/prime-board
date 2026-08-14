// Permite importar archivos .sql como texto (import attribute { type: "text" } de Bun).
declare module "*.sql" {
  const contents: string;
  export default contents;
}
