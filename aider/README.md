# Aider + UvA / HvA proxy

[Aider](https://aider.chat) is AI pair programming in your terminal. It connects
to any OpenAI-compatible endpoint, and it uses LiteLLM under the hood, so the
proxy is a natural fit.

## Setup

1. Install aider:

   ```bash
   python -m pip install aider-install
   aider-install
   ```

2. Point it at the proxy (from the
   [OpenAI-compatible APIs](https://aider.chat/docs/llms/openai-compat.html) docs):

   macOS / Linux:

   ```bash
   export OPENAI_API_BASE=https://llmproxy.uva.nl/v1      # or https://llmproxy.hva.nl/v1
   export OPENAI_API_KEY=YOUR_PROXY_KEY
   ```

   Windows (PowerShell), persistent:

   ```powershell
   setx OPENAI_API_BASE "https://llmproxy.uva.nl/v1"
   setx OPENAI_API_KEY "YOUR_PROXY_KEY"
   # restart the shell after setx
   ```

3. Run aider, prefixing the model id with `openai/`:

   ```bash
   cd /your/project
   aider --model openai/gpt-4o
   # or: aider --model openai/claude-sonnet-4.5
   ```

## Choosing a model

List available ids and prefix the one you want with `openai/`.

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

The `openai/` prefix tells aider to use the OpenAI-compatible path against
`OPENAI_API_BASE`. It works for every model the proxy serves (GPT, Claude, and
open-weight), because the proxy exposes them all through
`/v1/chat/completions`.

## Reasoning models

Aider has explicit reasoning controls (see
[Reasoning models](https://aider.chat/docs/config/reasoning.html)):

```bash
aider --model openai/gpt-5.6-sol --reasoning-effort high
```

Aider edits code through its own diff formats rather than function-calling
tools, so reasoning on the chat-completions endpoint generally works here
(the "reasoning_effort with tools" limitation that affects tool-using agents
does not usually apply to aider).

## Notes

- Model warnings: aider may warn that it doesn't recognise a proxy model id
  and doesn't know its context window. This is harmless. To silence it or set
  limits, see [Model warnings](https://aider.chat/docs/llms/warnings.html) and
  [Advanced model settings](https://aider.chat/docs/config/adv-model-settings.html).
- Keep the key in the environment, not in project files.

## Troubleshooting

- 401 / authentication error: check `OPENAI_API_KEY`.
- 404 / model not found: the id isn't served by the proxy, or you forgot the
  `openai/` prefix. List ids with the `curl` command above.
- Wrong base URL: confirm `OPENAI_API_BASE` ends in `/v1`.
