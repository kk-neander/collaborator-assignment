import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface LlmClient {
  readonly label: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  callsMade(): number;
}

export class LlmConfigError extends Error {}
export class LlmCallError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface LlmConfig {
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxCalls: number;
  maxOutputTokens: number;
  cacheDir?: string;
  maxTokensParam: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? "").trim();
  const model = (env.LLM_MODEL ?? "").trim();
  const problems: string[] = [];
  if (provider !== "anthropic" && provider !== "openai-compatible") {
    problems.push(`LLM_PROVIDER must be "anthropic" or "openai-compatible" (got "${provider}")`);
  }
  if (!model) problems.push("LLM_MODEL is empty: set the model id exactly as your provider lists it");
  if (provider === "openai-compatible" && !env.LLM_BASE_URL) problems.push("LLM_BASE_URL is required for openai-compatible");
  if (problems.length) {
    throw new LlmConfigError(
      `Ada needs a real LLM and the config is incomplete:\n  - ${problems.join("\n  - ")}\nEdit .env (see .env.example), then restart: ./sb restart bot`,
    );
  }
  return {
    provider: provider as LlmConfig["provider"],
    model,
    apiKey: env.LLM_API_KEY?.trim() || undefined,
    baseUrl: env.LLM_BASE_URL?.trim() || undefined,
    maxCalls: Number(env.BOT_MAX_CALLS ?? 40),
    maxOutputTokens: Number(env.BOT_MAX_OUTPUT_TOKENS ?? 4096),
    cacheDir: env.LLM_CACHE_DIR?.trim() || undefined,
    maxTokensParam: env.LLM_MAX_TOKENS_PARAM?.trim() || "max_tokens",
  };
}

type RawComplete = (req: LlmRequest) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

function anthropicAdapter(cfg: LlmConfig): RawComplete {
  const client = new Anthropic({
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    maxRetries: 2,
    timeout: 180_000,
  });
  return async (req) => {
    try {
      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      if (res.stop_reason === "refusal") throw new LlmCallError("the model declined this request", false);
      if (res.stop_reason === "max_tokens") throw new LlmCallError("the reply hit BOT_MAX_OUTPUT_TOKENS before finishing", false);
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    } catch (err) {
      if (err instanceof LlmCallError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new LlmCallError("Anthropic rejected LLM_API_KEY", false);
      if (err instanceof Anthropic.NotFoundError) throw new LlmCallError(`model "${cfg.model}" was not found`, false);
      if (err instanceof Anthropic.BadRequestError) throw new LlmCallError(`bad request: ${err.message}`, false);
      if (err instanceof Anthropic.RateLimitError) throw new LlmCallError("rate limited by Anthropic", true);
      if (err instanceof Anthropic.APIError) throw new LlmCallError(`Anthropic API error ${err.status}: ${err.message}`, true);
      throw new LlmCallError(`could not reach Anthropic: ${String(err)}`, true);
    }
  };
}

function openAiCompatibleAdapter(cfg: LlmConfig): RawComplete {
  const url = `${cfg.baseUrl!.replace(/\/+$/, "")}/chat/completions`;
  return async (req) => {
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      [cfg.maxTokensParam]: req.maxTokens,
    };
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        lastError = `could not reach ${url}: ${String(err)}`;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastError = `${res.status} from provider: ${text.slice(0, 300)}`;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const hint = res.status === 400 && /max_tokens|max_completion_tokens/.test(text) ? " (try LLM_MAX_TOKENS_PARAM=max_completion_tokens)" : "";
        throw new LlmCallError(`${res.status} from provider: ${text.slice(0, 300)}${hint}`, false);
      }
      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      if (choice?.finish_reason === "length") throw new LlmCallError("the reply hit BOT_MAX_OUTPUT_TOKENS before finishing", false);
      return {
        text: choice?.message?.content ?? "",
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      };
    }
    throw new LlmCallError(lastError || "provider kept failing", true);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createLlm(cfg: LlmConfig): LlmClient {
  const raw = cfg.provider === "anthropic" ? anthropicAdapter(cfg) : openAiCompatibleAdapter(cfg);
  let calls = 0;
  if (cfg.cacheDir) mkdirSync(cfg.cacheDir, { recursive: true });
  return {
    label: `${cfg.provider}:${cfg.model}`,
    callsMade: () => calls,
    async complete(req) {
      const maxTokens = Math.min(req.maxTokens, cfg.maxOutputTokens);
      const key = createHash("sha256")
        .update(JSON.stringify({ p: cfg.provider, m: cfg.model, s: req.system, u: req.user, t: maxTokens }))
        .digest("hex");
      const file = cfg.cacheDir ? join(cfg.cacheDir, `${key}.json`) : undefined;
      if (file && existsSync(file)) {
        const hit = JSON.parse(readFileSync(file, "utf8")) as Omit<LlmResponse, "cached">;
        return { ...hit, cached: true };
      }
      if (calls >= cfg.maxCalls) {
        throw new LlmCallError(`BOT_MAX_CALLS (${cfg.maxCalls}) reached; raise it in .env if you want Ada to keep going`, false);
      }
      calls += 1;
      const res = await raw({ ...req, maxTokens });
      if (file) writeFileSync(file, JSON.stringify(res));
      return { ...res, cached: false };
    },
  };
}
