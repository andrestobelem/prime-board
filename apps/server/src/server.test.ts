// Smoke test del hello-world (criterio de AT-130: `bun run server` levanta y responde).
import { describe, expect, it } from "bun:test";
import { createServer } from "./server.ts";

describe("server", () => {
  it("responde el hello-world en /", async () => {
    const server = createServer(0);
    try {
      const res = await fetch(`http://localhost:${server.port}/`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        name: "prime-board",
        message: "hello from prime-board",
      });
    } finally {
      server.stop();
    }
  });

  it("responde ok en /health y 404 en rutas desconocidas", async () => {
    const server = createServer(0);
    try {
      const health = await fetch(`http://localhost:${server.port}/health`);
      expect(await health.json()).toEqual({ status: "ok" });
      const missing = await fetch(`http://localhost:${server.port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
