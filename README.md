# Split Brain

A multiplayer code editor: several people and an AI agent (Ada) edit the same files live.

We planted 10–15 bugs in it, at random. Make the collaborative session work.

## Setup

You need Docker (Docker Desktop on macOS/Windows, Docker Engine on Linux) and git.

```bash
./sb up          # Windows PowerShell: .\sb.ps1 up
```

Then open http://localhost:8080/demo, or http://localhost:8080 to join as one person.

`./sb doctor` checks your machine, `./sb help` lists every command, and `./sb down` stops everything.

### Ada needs an LLM

`./sb up` creates `.env`. Fill in:

```bash
LLM_PROVIDER=anthropic            # or openai-compatible
LLM_MODEL=<model id exactly as your provider lists it>
LLM_API_KEY=<your key>
LLM_BASE_URL=                     # only for openai-compatible
```

Free option: run [Ollama](https://ollama.com) locally and set `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=http://host.docker.internal:11434/v1`, any model you have pulled, and no key. Then run `./sb restart bot`.

## Score

```bash
./sb score
```

## Submit

```bash
./sb submit you@example.com
```

This bundles your git history, your score history and your AI-assistant session transcripts for this folder only, uploads it to your personal submission link (from your invitation email; it asks the first time), and prints a receipt. Secrets are redacted. Preview it with `./sb trace --dry-run`, or leave transcripts out with `--skip-sessions`. You can submit again until the deadline; the latest submission counts.
