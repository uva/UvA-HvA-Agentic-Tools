# Pi extension (uva-hva-agentic-tools)

> Part of [uva-hva-agentic-tools](../README.md). This is the Pi guide; for other
> tools see [Claude Code](../claude-code/README.md),
> [VS Code](../vscode/README.md), [OpenCode](../opencode/README.md),
> [Aider](../aider/README.md), [Kilo Code](../kilo-code/README.md),
> [Factory Droid](../factory-droid/README.md), or
> [Odysseus](../odysseus/README.md).

[![npm version](https://img.shields.io/npm/v/pi-uva-hva)](https://www.npmjs.com/package/pi-uva-hva)

A [Pi](https://pi.dev) coding-agent provider extension for the University of
Amsterdam / Amsterdam University of Applied Sciences LiteLLM proxies
(https://llmproxy.uva.nl/v1, https://llmproxy.hva.nl/v1).

Get every UvA/HvA model working in Pi in under a minute, without editing Pi's config
files. Load the extension, run /login, pick your proxy, paste your API key, and
it auto-discovers all available models so you can select one straight from
/model. Your base URL and key are saved, so the next launch just reconnects.
Reasoning models come pre-tuned (thinking on at medium),
and tool-heavy agent turns that would otherwise silently come back empty on this
proxy just work. That's the whole setup; everything below is optional detail.

## Quick setup

Copy-paste these commands in a terminal. They install Node.js, Pi and the
[recommended extension set](#pi-harness-setup). If you only want the UvA/HvA
provider, use the [manual install](#install) instead.

### 1. Install Node.js (skip if node --version shows 22.19 or newer)

Windows (PowerShell):

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell afterwards so node and npm are found.

Linux / macOS (any distro, no admin rights needed, uses
[nvm](https://github.com/nvm-sh/nvm)):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install --lts
```

### 2. Install Pi

Same command on every platform:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

> Windows: if PowerShell says "running scripts is disabled on this system", run
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned once and try again.

### 3. Install the extensions

Windows (PowerShell):

```powershell
$pkgs = "pi-mcp-adapter","pi-simplify","pi-hermes-memory","@juicesharp/rpiv-voice",
  "pi-markdown-preview","opencode-codebase-index","pi-ask-user","pi-btw",
  "@gotgenes/pi-anthropic-auth","pi-subagents","awesome-pi-themes","pi-goal-x",
  "pi-advisor-flow","pi-uva-hva","@narumitw/pi-plan-mode","@dietrichgebert/ponytail"
foreach ($p in $pkgs) { pi install "npm:$p" }
pi list
```

Linux / macOS:

```bash
for p in pi-mcp-adapter pi-simplify pi-hermes-memory @juicesharp/rpiv-voice \
  pi-markdown-preview opencode-codebase-index pi-ask-user pi-btw \
  @gotgenes/pi-anthropic-auth pi-subagents awesome-pi-themes pi-goal-x \
  pi-advisor-flow pi-uva-hva @narumitw/pi-plan-mode @dietrichgebert/ponytail
do pi install "npm:$p"; done
pi list
```

Already-installed packages are fine to re-run. Want only some? Remove them from
the list; only pi-uva-hva is needed for the university proxy.

### 4. Log in and pick a model

Start pi, then:

1. Run /login, choose UvA / HvA proxy, pick your university and paste
   your own API key (never paste it into a chat or a repo).
2. Run /model and select a model.
3. Optional: for a model with a ~1M-token context, see the
   [recommended context window](#recommended-context-window-for-1m-models).

This is a package-selection snapshot, not a version-locked environment. New
installs resolve the published package versions available at installation time.
Extensions run with your account's permissions; review the packages before
installing them. Workflows, subagents and advisors can make additional model
calls, so check their routing and cost settings before use.

## Install

For the provider alone, you need Pi installed and a UvA/HvA proxy API key.

### 1. Load the extension

Pick one:

- From npm : run
  ```bash
  pi install npm:pi-uva-hva
  ```
- From a local clone: clone the repo and point at the pi/ folder instead:
  ```jsonc
  {
    "packages": [
      "/path/to/uva-hva-agentic-tools/pi"
    ]
  }
  ```

### 2. Connect with /login

Start Pi and run:

```
/login
```

Choose "UvA / HvA proxy", pick a base URL (UvA / HvA / custom), and paste
your API key. The extension discovers every model and saves your base URL + key
to ~/.pi/agent/openai-responses-uva.json, so the next launch reconnects with
nothing re-entered. /uva-login runs the same flow.

> Prefer env vars? Set UVA_API_KEY (and optionally UVA_BASE_URL) instead of
> /login. Both work.

### 3. Pick a model

```
/model           # select an available discovered model
```

Reasoning models default to thinking ON at medium. You can raise or lower a
model's default in /configure-models, or set the level per run from the CLI:

```bash
pi --provider uva --model gpt-5.6-sol --thinking high -p "hello"
```

## Configuration

/login is the easy path; everything is also configurable via environment
variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| UVA_API_KEY | - | API key, if you prefer env over /login. |
| UVA_BASE_URL | https://llmproxy.uva.nl/v1 | Proxy base URL (must end at the /v1 root). |
| UVA_PROVIDER_ID | uva | Provider id shown in /model and --provider. |
| UVA_CREDENTIALS_FILE | ~/.pi/agent/openai-responses-uva.json | Override the saved-credentials path. |
| UVA_NO_AUTO_THINKING | - | Set to disable the medium thinking default. |
| UVA_MODEL_OVERRIDES_FILE | - | Path to a JSON file overriding per-model capabilities (below). |

### Per-model overrides

Capabilities come from the proxy metadata (with a name-table fallback). To pin a
value yourself there are two ways.

Interactive menu (easiest): run /configure-models. Pick a model, then set
its context window and max output (type the number), toggle reasoning on/off,
and choose the default thinking level applied when that model is selected. Two
options at the end, Save & apply changes and Discard & exit. Saved
overrides are written to ~/.pi/agent/openai-responses-uva.models.json and
applied live (and on every future launch).

By hand: point UVA_MODEL_OVERRIDES_FILE at a JSON file (this overrides the
default path above):

```json
{
  "gpt-5.6-sol":    { "contextWindow": 272000, "maxTokens": 128000, "defaultThinkingLevel": "high" },
  "some-new-model": { "reasoning": false, "input": ["text", "image"], "contextWindow": 200000, "maxTokens": 32000 }
}
```

The defaultThinkingLevel on gpt-5.6-sol above is just an example of pinning
one model to high; by default every reasoning model starts at medium.

Each key is a model id; each value may set any of reasoning,
defaultThinkingLevel (off/low/medium/high), input, contextWindow,
maxTokens, vision, name, cost, thinkingLevelMap.

### Recommended context window for 1M models

Some models can read about one million tokens at once. We cap them at 272k
(272,000 tokens) in Pi, for two reasons:

1. Lower costs. In agentic work every step resends the whole conversation, so
   a huge context gets expensive fast. A cap makes Pi compact the history
   before it grows unnecessarily large.
2. Better answers. Once the context gets very full, models noticeably get
   worse: they miss details, forget instructions and make more mistakes (the
   "dumb zone"). Staying under 272k keeps the model in the range where it
   still works well.

The model can still handle more; 272k is just the working limit we chose.

To set it, run /configure-models in Pi, select your model, set Context window
to 272000, then choose Save & apply changes. Leave Max output tokens and the
other settings unchanged. Only do this for 1M models; don't raise smaller
models to 272k.

To configure it by hand, merge the following into
~/.pi/agent/openai-responses-uva.models.json (or your
UVA_MODEL_OVERRIDES_FILE), preserving all other models and settings:

```json
{
  "YOUR_DISCOVERED_1M_MODEL_ID": { "contextWindow": 272000 }
}
```

Replace the placeholder with an actual model ID from your proxy. Restart Pi
after a manual file edit; the interactive menu applies its changes live.
/configure-models belongs to this provider, not to all Pi providers. For other
providers, use their documented context override mechanism; Pi also supports
per-provider modelOverrides in ~/.pi/agent/models.json. A
contextWindow field in the general settings.json is not the equivalent.

## How it works

For each turn the custom stream handler:

1. Lets Pi's pristine built-in openai-responses handler build the exact
   request params (full message + tool conversion, reasoning, caching) via an
   onPayload hook that captures the params and throws before the network
   call, so nothing extra is billed.
2. Reissues the request itself and synthesizes Pi's content events
   (text / thinking / toolCall), reconciling the incremental SSE events
   with the terminal response.output[] by item id so a collapsed tool call is
   never lost. Tool-call ids and signatures are preserved for multi-turn replay.

Two dispatch paths keep it reliable:

- Non-reasoning turns stream (stream:true): bytes flow, so the nginx
  gateway read-timeout keeps resetting and output is token-by-token.
- Reasoning turns use background + poll (background:true +
  GET /responses/{id}): the model can buffer its whole reasoning phase with
  zero interim bytes without ever tripping a 504, because each request is short.
  A streaming turn that still hits a gateway 5xx before any output falls back to
  this path automatically.

Params incompatible with non-OpenAI backends (prompt_cache_key on
Bedrock/Vertex) are stripped per-model.

### Robust to model changes

The UvA/HvA line-up changes often, so nothing about specific models is
hard-coded. On connect the extension reads the proxy's own
/model_group/info and derives each model's context window, max output,
reasoning/vision support, cost, and backend directly from it, then decides the
endpoint from the backend (azure/bedrock speak the Responses API;
open-weight openai/vLLM models use chat-completions). If that metadata
endpoint is ever unavailable it falls back to /v1/models plus a researched
name table, and if a model is still mis-routed, a Responses turn that 404s is
self-healed at runtime (retried on chat-completions and remembered). So even
if every current model is replaced with new ones, discovery, capabilities, and
routing keep working with no code change.

### Trade-off

Reasoning replies are not token-by-token; they appear at once on completion
(the proxy only delivers background results as a single terminal payload).
Non-reasoning turns stream normally.

## Reasoning models

Reasoning is enabled per model from the proxy metadata (supports_reasoning or a
reasoning_effort parameter), with the name table as a fallback, but only on the
Responses route (chat-completions rejects reasoning_effort alongside tools).
Reasoning models default to thinking ON at medium (disable with
UVA_NO_AUTO_THINKING=1). Override any model's capabilities, including its
default thinking level, per-id via UVA_MODEL_OVERRIDES_FILE or
/configure-models.

## Compatibility

- Pi coding-agent with the @earendil-works/pi-ai runtime (verified on 0.80.x).
- Imports only the extension-facing @earendil-works/pi-ai surface, so it keeps
  working across Pi updates (it does not patch node_modules).

## Pi harness setup

This is a description of a recommended setup, not a
requirement to install everything just to use the university proxy. The
[quick setup](#quick-setup) contains the install commands.

### Context, memory & codebase tools

| Package | description |
| --- | --- |
| [pi-hermes-memory](https://www.npmjs.com/package/pi-hermes-memory) | Persistent memory, past-session search and reusable procedural skills. |
| [opencode-codebase-index](https://www.npmjs.com/package/opencode-codebase-index) | Semantic codebase search, symbol discovery and call-graph navigation. |
| [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) | Connect separately configured MCP tools and servers. |

### Planning, delegation & code quality

| Package | description |
| --- | --- |
| [@narumitw/pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode) | Read-only planning before implementation. |
| [pi-subagents](https://www.npmjs.com/package/pi-subagents) | Focused delegation and scripted multi-agent execution. |
| [pi-goal-x](https://www.npmjs.com/package/pi-goal-x) | Persistent goals, structured tasks, continuation and completion auditing. |
| [pi-advisor-flow](https://www.npmjs.com/package/pi-advisor-flow) | On-demand second opinions from an advisor model. |
| [pi-ask-user](https://www.npmjs.com/package/pi-ask-user) | Structured questions and explicit user decisions. |
| [pi-simplify](https://www.npmjs.com/package/pi-simplify) | Review changed code for clarity and maintainability. |
| [@dietrichgebert/ponytail](https://www.npmjs.com/package/@dietrichgebert/ponytail) | Keep implementations small and avoid unnecessary complexity. |

### Providers

| Package | description |
| --- | --- |
| [pi-uva-hva](https://www.npmjs.com/package/pi-uva-hva) | The UvA/HvA provider documented on this page. |
| [@gotgenes/pi-anthropic-auth](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth) | Anthropic OAuth compatibility. |

### Interface & convenience

| Package | description | 
| --- | --- |
| [@juicesharp/rpiv-voice](https://www.npmjs.com/package/@juicesharp/rpiv-voice) | Local speech-to-text dictation. |
| [pi-markdown-preview](https://www.npmjs.com/package/pi-markdown-preview) | Render Markdown/LaTeX and export previews. |
| [pi-btw](https://www.npmjs.com/package/pi-btw) | Side conversations without interrupting the main task. |
| [awesome-pi-themes](https://www.npmjs.com/package/awesome-pi-themes) | Additional terminal themes. |

## License

MIT. See [LICENSE](./LICENSE).
