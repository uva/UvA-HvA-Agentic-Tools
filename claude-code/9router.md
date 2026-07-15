# Claude Code + GPT / Qwen models via a 9router proxy

The [main Claude Code guide](./README.md) connects Claude Code straight to the
proxy's Anthropic endpoint, which only serves Claude models. This guide adds a
translation proxy so you can drive OpenAI models (like `gpt-5.6-luna`) and
open-weight models (like `Qwen3.6`) from Claude Code too.

## Why this is needed

Claude Code speaks exactly one API: the Anthropic Messages API
(`POST /v1/messages`). The UvA / HvA proxy exposes that shape **only for Claude
models**. Every other model on the proxy (OpenAI GPT, Qwen, mistral, gpt-oss)
lives behind the OpenAI-shaped endpoints (`/v1/chat/completions`,
`/v1/responses`), which Claude Code cannot call.

So to use a GPT or Qwen model in Claude Code you need something in the middle
that:

1. accepts Claude Code's Anthropic `/v1/messages` request,
2. translates it into the OpenAI format,
3. forwards it to the proxy's OpenAI endpoint,
4. translates the OpenAI reply back into Anthropic format.

[9router](https://github.com/decolua/9router) is a small local router that does
exactly this format translation (OpenAI to and from Anthropic). You point it at
your UvA / HvA proxy, then point Claude Code at 9router.

```
Claude Code  --(Anthropic /v1/messages)-->  9router  --(OpenAI /v1)-->  UvA proxy  -->  gpt-5.6-luna / Qwen3.6
```

> 9router (MIT, runs locally) has many other features (free-tier pooling,
> subscription interception, token savers). You do not need any of those here.
> This guide uses only its format-translation feature, pointed at your own
> proxy key. Mind each upstream's terms if you ever use the other features.

## Setup

### 1. Install and start 9router

It is a global npm package that runs a local server and dashboard:

```bash
npm install -g 9router
9router
```

The dashboard opens at `http://localhost:20128` and the router listens on
`http://localhost:20128/v1`. Leave it running while you use Claude Code.

### 2. Add the UvA / HvA proxy as a custom provider

In the dashboard (`http://localhost:20128`):

1. Go to **Providers** and add a provider of type **Custom OpenAI-compatible**
   (9router's provider list includes "custom OpenAI/Anthropic compatible
   endpoints").
2. Set:
   - **Base URL:** `https://llmproxy.uva.nl/v1` (or `https://llmproxy.hva.nl/v1`)
   - **API key:** your UvA / HvA proxy key
3. Save. Note the **model id** 9router assigns to your models. It prefixes the
   provider, so a model shows up as something like `uva/gpt-5.6-luna` or
   `uva/Qwen3.6` (the exact prefix is whatever you named the provider). You need
   this id in step 4.

If you are unsure of the raw model names the proxy serves, list them first:

Linux / macOS:

```bash
curl -s https://llmproxy.uva.nl/v1/models \
  -H "Authorization: Bearer YOUR_PROXY_KEY" | jq -r '.data[].id'
```

Windows (PowerShell):

```powershell
(Invoke-RestMethod https://llmproxy.uva.nl/v1/models `
  -Headers @{ Authorization = "Bearer YOUR_PROXY_KEY" }).data.id
```

### 3. Point Claude Code at 9router

Claude Code connects to any Anthropic-compatible endpoint through two
environment variables. Point them at 9router (not at the proxy directly), using
the API key from the 9router dashboard:

macOS / Linux (add to `~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_AUTH_TOKEN="YOUR_9ROUTER_KEY"       # copied from the 9router dashboard
```

Windows (PowerShell), persist for your user:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:20128", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "YOUR_9ROUTER_KEY", "User")
```

Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so the base is
`http://localhost:20128` with no `/v1`. If Claude Code cannot connect, check the
exact endpoint the 9router dashboard prints on its Claude Code setup page and
use that.

### 4. Select a GPT or Qwen model

Open a fresh terminal, then run Claude Code pinned to the 9router model id from
step 2:

```bash
export ANTHROPIC_MODEL="uva/gpt-5.6-luna"      # or uva/Qwen3.6, etc.
claude
```

You can also switch mid-session with `/model uva/gpt-5.6-luna`.

## Notes and limits

- **Reasoning models.** 9router translates into OpenAI chat-completions. For a
  GPT reasoning model that is fine for normal use, but fine-grained
  `reasoning_effort` control and the proxy's `/v1/responses` path (needed for
  reasoning together with tool calls) do not pass through the translation. If
  you want GPT reasoning + tools done right, use the
  [Pi extension](../pi/README.md), which talks `/v1/responses` directly.
  Non-reasoning models like `Qwen3.6` translate cleanly.
- **Keep 9router running.** It is a local server. If it is not running, Claude
  Code gets a connection error.
- **Claude models still work directly.** For Claude models you do not need
  9router at all, use the [direct setup](./README.md), it is simpler and avoids
  the translation entirely.
- **Key handling.** Your UvA key lives only in the 9router dashboard;
  `ANTHROPIC_AUTH_TOKEN` is 9router's own key, not your proxy key.

## Troubleshooting

- **Connection refused / 404 on `/v1/messages`:** 9router is not running, or
  `ANTHROPIC_BASE_URL` has a trailing `/v1`. Use `http://localhost:20128`.
- **401 from the proxy:** the UvA key in the 9router provider config is wrong or
  expired. Fix it in the dashboard, not in `ANTHROPIC_AUTH_TOKEN`.
- **Model not found:** the model id must be 9router's prefixed id
  (`<provider>/<model>`), not the bare proxy id. Check the dashboard.
- **Empty or broken tool turns on a GPT reasoning model:** that is the
  chat-completions vs `/v1/responses` limitation above. Switch to `Qwen3.6`, a
  non-reasoning GPT model, or use [Pi](../pi/README.md).
