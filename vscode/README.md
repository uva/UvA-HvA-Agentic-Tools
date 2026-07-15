# VS Code (Copilot Chat) + UvA / HvA proxy

Use the proxy's models inside VS Code's built-in chat (GitHub Copilot Chat)
via the
[LiteLLM Provider for GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
extension. Because our proxy *is* a LiteLLM gateway, this drops in directly:
the extension reads the model list and each model's limits straight from the
proxy and adds them to the Copilot Chat model picker.

## Requirements

- VS Code 1.108.0 or newer.
- The GitHub Copilot Chat extension (VS Code's chat UI).
- A proxy API key.

## Setup

1. Install the extension. In VS Code, open Extensions and search for
   *"LiteLLM Provider for GitHub Copilot Chat"* (publisher Vivswan), or open
   the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
   and click Install.

2. Add the proxy as a server. Open the chat view, click the model picker,
   choose "Manage Models..." -> "LiteLLM" (or run
   "Manage LiteLLM Provider" from the Command Palette,
   `Ctrl+Shift+P` / `Cmd+Shift+P`). Then Add Server:

   - Label: `UvA` (or `HvA`)
   - Base URL: `https://llmproxy.uva.nl`  (or `https://llmproxy.hva.nl`)
   - API key: your proxy key

   The key is stored in VS Code's secret storage, not in settings files.

3. Select models. Pick the models you want from the list the extension
   fetched. They now appear in the Copilot Chat model picker.

4. Verify. Run "LiteLLM: Test Connection" from the Command Palette, or
   check the LiteLLM status bar indicator (bottom-right). `✓ LiteLLM (N)` means
   N models are reachable.

## Recommended settings

Open Settings (`Ctrl+,` / `Cmd+,`) and search `litellm-vscode-chat`, or edit
`settings.json`.

Longer timeouts for reasoning models. Reasoning turns can take a while;
raise the request timeout so long generations aren't cut off client-side:

```json
{
  "litellm-vscode-chat.requestTimeout": 600000,
  "litellm-vscode-chat.discoveryTimeout": 60000
}
```

Prompt caching for Claude. Cheaper and faster on Claude models:

```json
{
  "litellm-vscode-chat.promptCaching.enabled": true
}
```

Per-model parameters. Control reasoning effort or other options per model.
Note some GPT-5 models require `temperature: 1`:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-5": { "temperature": 1 },
    "gpt-5.6-sol": { "reasoning_effort": "high" },
    "claude-sonnet-4.5": { "reasoning_effort": "medium" }
  }
}
```

The extension auto-reads context window and max-output limits from the proxy's
model info; the `defaultContextLength` / `defaultMaxOutputTokens` settings are
only fallbacks.

## Notes and limits

- Endpoint: this extension uses the proxy's `/v1/chat/completions` endpoint.
  That is perfectly fine for plain chat and for Claude models. However, OpenAI
  GPT reasoning models (`gpt-5.x`) reject `reasoning_effort` when tool calls
  are also present on that endpoint (the proxy asks you to use `/v1/responses`
  instead, which this extension does not use). So in Copilot's tool-using
  *agent* flows, prefer Claude models, or a non-reasoning GPT model, or use
  [Pi](../pi/README.md), which routes reasoning + tools through `/v1/responses`
  automatically.
- Gateway timeouts: a very long reasoning turn can still hit a server-side
  gateway timeout regardless of the client `requestTimeout`. If that happens,
  lower the reasoning effort for that model via `modelParameters`.
- Custom auth headers: if your gateway expects a non-standard header, set
  `litellm-vscode-chat.headers` (User settings, so secrets aren't committed).

## Troubleshooting

- No models in the picker: click the status bar indicator for diagnostics,
  or run "LiteLLM: Test Connection". Check the base URL and key.
- Authentication failed: re-open "Manage LiteLLM Provider" and update the
  server's API key.
- Server returned 0 models: the base URL is reachable but wrong path or the
  key lacks access; confirm `https://llmproxy.uva.nl/v1/models` returns a list
  with your key.
