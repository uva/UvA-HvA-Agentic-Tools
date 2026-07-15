# OpenCode + UvA / HvA proxy

[OpenCode](https://opencode.ai) is a terminal coding agent built on the Vercel
AI SDK. It supports custom OpenAI-compatible providers, so you point it at
the proxy's `/v1` endpoint and add the models you want.

This same pattern works for any tool that accepts an OpenAI-compatible base URL
plus key (Continue, Cline, Aider, custom scripts, and so on).

## Setup

1. Set your key as an environment variable so it isn't written into config.

   Linux / macOS (add to `~/.bashrc` or `~/.zshrc` to persist):

   ```bash
   export UVA_API_KEY="YOUR_PROXY_KEY"          # or HVA_API_KEY
   ```

   Windows (PowerShell), then restart the shell:

   ```powershell
   setx UVA_API_KEY "YOUR_PROXY_KEY"
   ```

2. Add the provider to your OpenCode config. Use the global config for all
   projects (`~/.config/opencode/opencode.json` on Linux and macOS,
   `%USERPROFILE%\.config\opencode\opencode.json` on Windows), or `opencode.json`
   in a project root for just that project:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "uva": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "UvA proxy",
         "options": {
           "baseURL": "https://llmproxy.uva.nl/v1",
           "apiKey": "{env:UVA_API_KEY}"
         },
         "models": {
           "gpt-4o": { "name": "GPT-4o (UvA)" },
           "claude-sonnet-4.5": { "name": "Claude Sonnet 4.5 (UvA)" },
           "gpt-5.6-sol": { "name": "GPT-5.6 Sol (UvA)" }
         }
       }
     }
   }
   ```

   For HvA, use `https://llmproxy.hva.nl/v1` and `{env:HVA_API_KEY}`.

3. Run OpenCode and select a model from the `uva` provider with `/models`.

## Choosing models to list

`@ai-sdk/openai-compatible` does not auto-discover, so list ids for the
`models` block yourself.

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

Add the ones you care about under `models`. You can set a display `name`,
`limit` (context/output), and other AI SDK model options per entry.

## Notes and limits

- Endpoint: the OpenAI-compatible provider uses `/v1/chat/completions`. This
  is fine for plain chat and for Claude models. But OpenAI GPT reasoning
  models (`gpt-5.x`) reject `reasoning_effort` alongside tool calls on that
  endpoint; the proxy wants `/v1/responses` for that combination. So for
  tool-using agent runs on GPT reasoning models, prefer Claude, a non-reasoning
  GPT model, or use [Pi](../pi/README.md), which routes reasoning + tools
  through `/v1/responses` automatically.
- Long reasoning turns can hit a server-side gateway timeout; lower the
  reasoning effort or pick a lighter model if you see one.
- Keep the key in `{env:...}`, not inline, so `opencode.json` is safe to
  commit or share.

## Generic OpenAI-compatible tools

Any client that takes an OpenAI base URL and key uses the same three values:

- Base URL: `https://llmproxy.uva.nl/v1` (or `.../hva.nl/v1`)
- API key: your proxy key
- Model: an id from `/v1/models`

The reasoning + tools caveat above applies wherever the client calls
`/v1/chat/completions`.

## Troubleshooting

- 401: wrong or expired key.
- 404 model not found: the id isn't in `/v1/models`, or it is misspelled.
- Empty reply / error on a GPT reasoning model with tools: that is the
  `/v1/responses` limitation above; switch model or use Pi.
