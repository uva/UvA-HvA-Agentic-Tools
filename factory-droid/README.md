# Factory Droid + UvA / HvA proxy

[Factory](https://factory.ai)'s Droid CLI supports Bring Your Own Key
(BYOK): you add custom models in a JSON settings file and switch to them with
`/model`. Its `provider` field maps cleanly onto the proxy's endpoints.

Based on the official
[BYOK docs](https://docs.factory.ai/cli/byok/overview).

## Setup

1. Set your key as an environment variable.

   Linux / macOS (add to `~/.bashrc` or `~/.zshrc` to persist):

   ```bash
   export UVA_API_KEY="YOUR_PROXY_KEY"          # or HVA_API_KEY
   ```

   Windows (PowerShell), then restart the shell:

   ```powershell
   setx UVA_API_KEY "YOUR_PROXY_KEY"
   ```

2. Add custom models under `customModels` in Droid's settings file:
   `~/.factory/settings.json` on Linux and macOS,
   `%USERPROFILE%\.factory\settings.json` on Windows.
   Choose the `provider` per model so the right endpoint is used:

   ```json
   {
     "customModels": [
       {
         "model": "claude-sonnet-4.5",
         "displayName": "Claude Sonnet 4.5 (UvA)",
         "baseUrl": "https://llmproxy.uva.nl",
         "apiKey": "${UVA_API_KEY}",
         "provider": "anthropic",
         "maxOutputTokens": 64000
       },
       {
         "model": "gpt-5.6-sol",
         "displayName": "GPT-5.6 Sol (UvA)",
         "baseUrl": "https://llmproxy.uva.nl/v1",
         "apiKey": "${UVA_API_KEY}",
         "provider": "openai",
         "maxOutputTokens": 128000
       },
       {
         "model": "gpt-4o",
         "displayName": "GPT-4o (UvA)",
         "baseUrl": "https://llmproxy.uva.nl/v1",
         "apiKey": "${UVA_API_KEY}",
         "provider": "generic-chat-completion-api",
         "maxOutputTokens": 16384
       }
     ]
   }
   ```

3. Run `droid` and pick a model with `/model`. Custom models appear in their
   own section. Config changes are picked up automatically (file watching), no
   restart needed.

## Which `provider` to use

| Models | `provider` | Endpoint used | Base URL |
| --- | --- | --- | --- |
| Anthropic (`claude-*`) | `anthropic` | Anthropic Messages (`/v1/messages`) | `https://llmproxy.uva.nl` |
| OpenAI reasoning (`gpt-5.x`, `o*`) | `openai` | OpenAI Responses (`/v1/responses`) | `https://llmproxy.uva.nl/v1` |
| GPT-4 + open-weight (`gpt-4o`, `gpt-oss`, `Qwen`, `mistral`) | `generic-chat-completion-api` | Chat Completions (`/v1/chat/completions`) | `https://llmproxy.uva.nl/v1` |

Factory notes that `provider: "openai"` (Responses API) is required for the
newest GPT-5 models, which is exactly why the reasoning models go there rather
than `generic-chat-completion-api`.

## Choosing model ids

List what the proxy serves and copy the ids into the `model` field.

Linux / macOS:

```bash
curl -s https://llmproxy.uva.nl/v1/models \
  -H "Authorization: Bearer YOUR_PROXY_KEY" | jq -r '.data[].id'
```

Windows (PowerShell), no extra tools needed:

```powershell
(Invoke-RestMethod https://llmproxy.uva.nl/v1/models `
  -Headers @{ Authorization = "Bearer YOUR_PROXY_KEY" }).data.id
```

## Notes

- `apiKey` env expansion (`${UVA_API_KEY}`) works in `settings.json` and
  `settings.local.json`, so you do not store the key in the file.
- Optional fields: `noImageSupport`, `extraArgs` (for example
  `temperature`), and `extraHeaders` are available per model.
- `maxOutputTokens` is optional but recommended so responses are not clipped.

## Troubleshooting

- Model not appearing: check JSON syntax and that all required fields
  (`model`, `baseUrl`, `apiKey`, `provider`) are present.
- "Invalid provider": `provider` must be exactly `anthropic`, `openai`, or
  `generic-chat-completion-api`.
- Authentication errors: verify the key and that `baseUrl` matches the table
  above.
