#!/usr/bin/env bun
// MCP server de prime-board por stdio (spec §8).
// Config: PRIME_BOARD_URL (default http://localhost:3333) y PRIME_BOARD_API_KEY.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig } from "./api.ts";
import { createServer } from "./server.ts";

const config = loadMcpConfig();
const server = createServer(config);
await server.connect(new StdioServerTransport());
console.error(`prime-board MCP server ready (${config.url})`);
