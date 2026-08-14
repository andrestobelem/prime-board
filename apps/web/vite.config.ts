// Config de Vite: en dev proxya /graphql al server Bun (puerto PRIME_BOARD_PORT).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/graphql": `http://localhost:${process.env.PRIME_BOARD_PORT ?? 3333}`,
    },
  },
});
