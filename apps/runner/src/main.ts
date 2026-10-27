import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 5000);
const DEPS = process.env.RUNNER_DEPS ?? "/opt/tiny-notes/node_modules";
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT = 64_000;

const COMMANDS: Record<string, string[]> = {
  test: ["node", join(DEPS, "vitest/vitest.mjs"), "run", "--reporter=dot"],
  typecheck: ["node", join(DEPS, "typescript/bin/tsc"), "--noEmit", "-p", "."],
};

function log(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), svc: "runner", event, ...data })}\n`);
}

interface RunRequest {
  files: Array<{ path: string; text: string }>;
  command: string;
  requestedBy?: string;
}

function run(req: RunRequest): Promise<{ exitCode: number; output: string; durationMs: number; timedOut: boolean }> {
  const argv = COMMANDS[req.command];
  if (!argv) return Promise.resolve({ exitCode: 2, output: `unknown command ${req.command}`, durationMs: 0, timedOut: false });
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  for (const f of req.files) {
    const target = normalize(join(dir, f.path));
    if (!target.startsWith(dir + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.text);
  }
  symlinkSync(DEPS, join(dir, "node_modules"), "dir");
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env: { PATH: process.env.PATH, CI: "1", NO_COLOR: "1" } });
    let output = "";
    const take = (b: Buffer) => {
      if (output.length < MAX_OUTPUT) output += b.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ exitCode: code ?? 1, output: output.slice(0, MAX_OUTPUT), durationMs: Date.now() - started, timedOut });
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.url !== "/run" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: RunRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunRequest;
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }
  const result = await run(body);
  log("run", { command: body.command, requestedBy: body.requestedBy, exitCode: result.exitCode, ms: result.durationMs });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
});

server.listen(PORT, () => log("listening", { port: PORT, deps: DEPS }));
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => process.exit(0));
