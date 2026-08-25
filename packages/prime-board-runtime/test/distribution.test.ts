import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const packageRoot = join(repoRoot, "packages", "prime-board-runtime");
const sourceMigrations = join(repoRoot, "apps", "server", "src", "db", "migrations");
const builtDist = join(packageRoot, "dist");

type Environment = Record<string, string>;
type Child = ReturnType<typeof Bun.spawn>;

function cleanEnvironment(): Environment {
  const result: Environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) result[key] = value;
  }
  return result;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function commandOutput(result: Bun.SyncSubprocess): string {
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  return `${stdout}${stderr}`;
}

function runChecked(args: string[], cwd: string, env: Environment, label: string): string {
  const result = Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const output = commandOutput(result);
  if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${output}`);
  return output;
}

async function streamText(stream: Child["stdout"]): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream).text();
}

async function childOutput(child: Child): Promise<string> {
  const [stdout, stderr] = await Promise.all([streamText(child.stdout), streamText(child.stderr)]);
  return `${stdout}${stderr}`;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not inspect the temporary port"));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(child: Child, url: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The launcher may still be building the SQLite schema or transferring its lock.
    }
    await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 50));
  }
  const output = await childOutput(child);
  throw new Error(`Timed out waiting for ${url}/health\n${output}`);
}

interface GraphqlRequest {
  response: Response;
  body: Record<string, unknown>;
}

async function graphql(url: string, query: string, apiKey?: string): Promise<GraphqlRequest> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${url}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  return { response, body: objectValue(await response.json(), "GraphQL response") };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertFreshArtifact(): void {
  const source = readdirSync(sourceMigrations)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const built = readdirSync(join(builtDist, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(built).toEqual(source);
  for (const name of source) {
    expect(readFileSync(join(builtDist, "migrations", name), "utf8")).toBe(
      readFileSync(join(sourceMigrations, name), "utf8"),
    );
  }

  const manifest = objectValue(
    JSON.parse(readFileSync(join(builtDist, "manifest.json"), "utf8")) as unknown,
    "manifest",
  );
  const entries = arrayValue(manifest.files, "manifest.files");
  const manifestPaths = new Set<string>();
  for (const entryValue of entries) {
    const entry = objectValue(entryValue, "manifest entry");
    const path = stringValue(entry.path, "manifest path");
    const digest = stringValue(entry.sha256, "manifest checksum");
    manifestPaths.add(path);
    expect(existsSync(join(builtDist, path))).toBe(true);
    expect(sha256(join(builtDist, path))).toBe(digest);
  }
  expect(manifestPaths.has("server.js")).toBe(true);
  expect(manifestPaths.has("cli.js")).toBe(true);
  expect(manifestPaths.has("web/index.html")).toBe(true);
  expect([...manifestPaths].filter((path) => path.startsWith("migrations/")).length).toBe(
    source.length,
  );
}

describe("distribución del runtime", () => {
  test("arranca desde un package limpio y conserva la réplica al reabrir", async () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-runtime-smoke-"));
    const home = join(root, "home");
    const repository = join(root, "repository");
    const consumer = join(root, "consumer");
    const database = join(root, "state", "board.sqlite");
    const cleanEnv = cleanEnvironment();
    let launcher: Child | undefined;
    let packageTarball: string | undefined;

    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(repository, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      expect(repository.startsWith(repoRoot)).toBe(false);
      expect(consumer.startsWith(repoRoot)).toBe(false);

      // El fixture Git también usa un entorno sin GIT_* heredadas.
      runChecked(["git", "init", "-q", repository], root, cleanEnv, "git fixture");
      writeFileSync(join(consumer, "package.json"), '{"name":"runtime-smoke","private":true}\n');

      runChecked([process.execPath, "run", "build:runtime"], repoRoot, cleanEnv, "runtime build");
      assertFreshArtifact();

      for (const name of readdirSync(packageRoot)) {
        if (name.endsWith(".tgz")) rmSync(join(packageRoot, name), { force: true });
      }
      runChecked(
        ["npm", "pack", "--ignore-scripts", "--json"],
        packageRoot,
        cleanEnv,
        "runtime package",
      );
      const tarballs = readdirSync(packageRoot).filter((name) => name.endsWith(".tgz"));
      expect(tarballs).toHaveLength(1);
      packageTarball = join(packageRoot, tarballs[0]!);

      runChecked(
        ["npm", "install", "--ignore-scripts", packageTarball],
        consumer,
        cleanEnv,
        "clean package install",
      );
      const runtimeBinary = join(
        consumer,
        "node_modules",
        "@prime-board",
        "runtime",
        "dist",
        "cli.js",
      );
      expect(existsSync(runtimeBinary)).toBe(true);
      expect(runtimeBinary.startsWith(repoRoot)).toBe(false);

      const port = await freePort();
      expect(port).not.toBe(3333);
      const runtimeEnv = { ...cleanEnv };
      for (const key of Object.keys(runtimeEnv)) {
        if (key.startsWith("PRIME_BOARD_")) delete runtimeEnv[key];
      }
      runtimeEnv.HOME = home;
      runtimeEnv.NODE_ENV = "production";
      runtimeEnv.PRIME_BOARD_AUTH_MODE = "api-key";

      const start = (): Child => {
        const child = Bun.spawn(
          [
            process.execPath,
            runtimeBinary,
            "--project",
            repository,
            "--db",
            database,
            "--port",
            String(port),
          ],
          { cwd: consumer, env: runtimeEnv, stdout: "pipe", stderr: "pipe" },
        );
        launcher = child;
        return child;
      };
      const stop = async (): Promise<string> => {
        if (!launcher) return "";
        launcher.kill("SIGTERM");
        await launcher.exited;
        const output = await childOutput(launcher);
        launcher = undefined;
        return output;
      };

      let child = start();
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(child, baseUrl);

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const page = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(html).toContain('<div id="root"></div>');
      const asset = html.match(/(?:src|href)="(\/assets\/[^\"]+)"/)?.[1];
      expect(asset).toBeString();
      const assetResponse = await fetch(`${baseUrl}${asset}`);
      expect(assetResponse.status).toBe(200);

      const unauthorized = await graphql(baseUrl, "{ workspace { id } }");
      expect(unauthorized.body.data === undefined || unauthorized.body.data === null).toBe(true);
      expect(unauthorized.body.errors).toBeDefined();

      const credentials = readdirSync(join(home, ".prime-board", "credentials"));
      expect(credentials).toHaveLength(1);
      const credentialPath = join(home, ".prime-board", "credentials", credentials[0]!);
      expect(credentialPath.startsWith(repository)).toBe(false);
      const credential = objectValue(
        JSON.parse(readFileSync(credentialPath, "utf8")) as unknown,
        "bootstrap credential",
      );
      const apiKey = stringValue(credential.apiKey, "bootstrap API key");
      expect(apiKey.startsWith("pb_")).toBe(true);

      const mutation = await graphql(
        baseUrl,
        'mutation { issueCreate(input: { teamKey: "PB", title: "artifact smoke" }) { success issue { id identifier } } }',
        apiKey,
      );
      expect(mutation.response.status).toBe(200);
      expect(mutation.body.errors).toBeUndefined();
      const mutationData = objectValue(mutation.body.data, "mutation data");
      const created = objectValue(mutationData.issueCreate, "issueCreate");
      const issue = objectValue(created.issue, "created issue");
      const issueId = stringValue(issue.id, "issue id");
      const identifier = stringValue(issue.identifier, "issue identifier");
      expect(created.success).toBe(true);

      const issueSnapshot = join(repository, ".prime-board", "issues", `${identifier}.md`);
      const issueLog = join(repository, ".prime-board", "log", `${identifier}.jsonl`);
      expect(existsSync(issueSnapshot)).toBe(true);
      expect(existsSync(issueLog)).toBe(true);
      expect(readFileSync(issueSnapshot, "utf8")).toContain("artifact smoke");
      expect(readFileSync(issueLog, "utf8")).toContain(`"issue":"${identifier}"`);
      expect(existsSync(join(repository, ".prime-board", "meta", "export.json"))).toBe(true);
      expect(readFileSync(issueSnapshot, "utf8")).not.toContain(repoRoot);

      const firstOutput = await stop();
      expect(firstOutput).not.toContain(repoRoot);

      child = start();
      await waitForHealth(child, baseUrl);
      const reopened = await graphql(
        baseUrl,
        `{ issue(id: "${issueId}") { identifier title } }`,
        apiKey,
      );
      expect(reopened.body.errors).toBeUndefined();
      const reopenedData = objectValue(reopened.body.data, "reopened data");
      const reopenedIssue = objectValue(reopenedData.issue, "reopened issue");
      expect(reopenedIssue).toEqual({ identifier, title: "artifact smoke" });
      expect(readFileSync(issueSnapshot, "utf8")).toContain("artifact smoke");
      expect(readFileSync(issueLog, "utf8")).toContain(`"issue":"${identifier}"`);

      const secondOutput = await stop();
      expect(secondOutput).not.toContain(repoRoot);
    } finally {
      if (launcher) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      if (packageTarball) rmSync(packageTarball, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
