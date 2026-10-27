#!/usr/bin/env node
// Checks that this machine can run Split Brain and explains how to fix what's missing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { totalmem, platform, arch } from "node:os";
import { createServer } from "node:net";

const results = [];
const ok = (name, detail = "") => results.push(["ok", name, detail]);
const warn = (name, detail) => results.push(["warn", name, detail]);
const fail = (name, detail) => results.push(["fail", name, detail]);

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

const env = existsSync(".env")
  ? Object.fromEntries(
      readFileSync(".env", "utf8")
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
    )
  : null;

// Docker
const dockerVersion = run("docker", ["version", "--format", "{{.Server.Version}}"]);
if (dockerVersion === null) {
  run("docker", ["--version"]) === null
    ? fail("Docker", "not installed — install Docker Desktop (macOS/Windows) or Docker Engine (Linux)")
    : fail("Docker", "installed but not running — start Docker Desktop / the docker service");
} else ok("Docker", `engine ${dockerVersion}`);

const composeVersion = run("docker", ["compose", "version", "--short"]);
if (composeVersion === null) fail("Docker Compose", "v2 plugin missing — update Docker Desktop or install docker-compose-plugin");
else {
  const [maj, min] = composeVersion.replace(/^v/, "").split(".").map(Number);
  if (maj > 2 || (maj === 2 && min >= 24)) ok("Docker Compose", composeVersion);
  else fail("Docker Compose", `${composeVersion} is too old; need 2.24+ — update Docker`);
}

// Docker network address pools (many compose projects exhaust them)
if (dockerVersion !== null) {
  const probe = `split-brain-doctor-${process.pid}`;
  const made = run("docker", ["network", "create", probe]);
  if (made === null) {
    warn("Docker networks", "no free default address pools; ./sb up will fall back to fixed subnets (compose.subnets.yml). `docker network prune` frees unused ones.");
  } else {
    run("docker", ["network", "rm", probe]);
    ok("Docker networks", "address pools available");
  }
}

// Node (optional on host)
const [nMaj, nMin] = process.versions.node.split(".").map(Number);
if (nMaj > 22 || (nMaj === 22 && nMin >= 18)) ok("Node.js", `${process.versions.node} (runs everything on the host too)`);
else warn("Node.js", `${process.versions.node}: fine for trace/submit; score/test will run inside Docker (host needs 22.18+)`);

// Git
const gitVersion = run("git", ["--version"]);
gitVersion ? ok("Git", gitVersion) : fail("Git", "not installed — needed for your commit history and submission");
const autocrlf = run("git", ["config", "core.autocrlf"]);
if (platform() === "win32" && autocrlf === "true") warn("Git line endings", "core.autocrlf=true; this repo's .gitattributes keeps scripts LF, but run ./sb from WSL/Git Bash if bash complains about $'\\r'");

// Memory
const gb = totalmem() / 2 ** 30;
gb >= 4 ? ok("Memory", `${gb.toFixed(1)} GB`) : warn("Memory", `${gb.toFixed(1)} GB — 4 GB+ recommended; give Docker Desktop at least 3 GB`);

// Port
const port = Number(env?.SB_PORT || 8080);
const busy = !(await portFree(port));
const ours = run("docker", ["compose", "ps", "--status", "running", "--services"])?.split("\n").includes("chaos");
if (!busy || ours) ok("Port", `${port}${ours ? " (Split Brain is running)" : " is free"}`);
else fail("Port", `${port} is in use — set SB_PORT=<free port> in .env`);

// LLM config
if (!env) warn(".env", "missing — ./sb up creates it from .env.example");
else {
  const provider = env.LLM_PROVIDER;
  const local = /localhost|127\.0\.0\.1|host\.docker\.internal/.test(env.LLM_BASE_URL ?? "");
  if (!["anthropic", "openai-compatible"].includes(provider)) fail("LLM_PROVIDER", `"${provider ?? ""}" — set anthropic or openai-compatible (Ada needs a real LLM)`);
  else ok("LLM_PROVIDER", provider);
  env.LLM_MODEL ? ok("LLM_MODEL", env.LLM_MODEL) : fail("LLM_MODEL", "empty — set the model id exactly as your provider lists it");
  if (provider === "openai-compatible" && !env.LLM_BASE_URL) fail("LLM_BASE_URL", "required for openai-compatible");
  if (!env.LLM_API_KEY && !local) fail("LLM_API_KEY", "empty — add a key, or point LLM_BASE_URL at a local Ollama (free)");
  else ok("LLM_API_KEY", env.LLM_API_KEY ? "set" : "not needed (local server)");
}

const icon = { ok: "✓", warn: "!", fail: "✗" };
console.log(`Split Brain doctor — ${platform()} ${arch()}\n`);
for (const [level, name, detail] of results) console.log(` ${icon[level]} ${name.padEnd(16)} ${detail}`);
const failed = results.filter((r) => r[0] === "fail").length;
console.log(failed ? `\n${failed} problem(s) to fix.` : "\nAll good. Run ./sb up");
process.exit(failed ? 1 : 0);
