# Kilo Code + UvA / HvA proxy

[Kilo Code](https://kilocode.ai) is an AI coding agent for VS Code (and a CLI).
It supports custom providers, including OpenAI-compatible, OpenAI Responses, and
Anthropic Messages endpoints, so it can talk to the proxy on whichever endpoint
suits the model.

Based on the official
[OpenAI-compatible providers](https://kilo.ai/docs/ai-providers/openai-compatible)
docs.

## Setup (VS Code)

1. Open Kilo Code's Settings (gear icon) and go to the Providers tab.
2. Scroll to the bottom and click Custom provider.
3. Fill in the dialog:
   - Provider ID: `uva` (or `hva`)
   - Display name: `UvA proxy`
   - Provider API: see the table below for which to pick
   - Base URL: `https://llmproxy.uva.nl/v1` (or `https://llmproxy.hva.nl/v1`)
   - API key: your proxy key
   - Models: Kilo auto-fetches the list from `/v1/models`; pick the ones you want
4. Click Submit. The models appear in the model picker.

### Which "Provider API" to choose

The proxy speaks several API shapes. Pick the one that matches the model so
reasoning and tools behave:

| Models | Provider API | Base URL |
| --- | --- | --- |
| Open-weight + GPT-4 (`gpt-4o`, `gpt-oss`, `Qwen`, `mistral`) | **OpenAI Compatible** | `https://llmproxy.uva.nl/v1` |
| OpenAI reasoning (`gpt-5.x`, `o*`) | **OpenAI Responses** | `https://llmproxy.uva.nl/v1` |
| Anthropic (`claude-*`) | **Anthropic Messages** | `https://llmproxy.uva.nl` |

Using OpenAI Responses for the GPT-5.x reasoning models is what lets
`reasoning_effort` work together with tool calls (the plain OpenAI Compatible
path rejects that combination). You can add more than one custom provider, one
per API shape, and mix their models freely.

## Setup (CLI)

The Kilo CLI reads provider options from `kilo.jsonc`. Keep the key in an
environment variable rather than inline.

Linux / macOS:

```bash
export UVA_API_KEY="YOUR_PROXY_KEY"
```

Windows (PowerShell), then restart the shell:

```powershell
setx UVA_API_KEY "YOUR_PROXY_KEY"
```

Then reference it from `kilo.jsonc`:

```jsonc
{
  "provider": {
    "uva": {
      "options": {
        "apiKey": "{env:UVA_API_KEY}",
        "baseURL": "https://llmproxy.uva.nl/v1",
        "timeout": 600000
      }
    }
  }
}
```

See the [Custom Models](https://kilo.ai/docs/code-with-ai/agents/custom-models)
docs for per-model options (token limits, tool calling).

## Notes

- Automatic model detection: once the Base URL and key are valid, Kilo
  queries `/v1/models` and offers a searchable picker, so you rarely type ids by
  hand.
- Key handling: in VS Code the key is stored by the extension; in the CLI
  keep it in `{env:...}`, not inline.
- Timeouts: raise the CLI `timeout` for long reasoning turns.

## Troubleshooting

- Invalid API key: re-check the key in the provider dialog.
- Model not found: use an id from `/v1/models`.
- A GPT-5.x model errors with tools on "OpenAI Compatible": switch that
  provider's API to OpenAI Responses.
