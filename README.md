# Use the UvA / HvA AI with your favourite agentic tools!

For students, staff, and developers at the University of Amsterdam (UvA) and
the Amsterdam University of Applied Sciences (HvA). The universities run a
shared [LiteLLM](https://litellm.ai) gateway that exposes GPT, Claude, and
open-weight models behind one API key. This repo collects short, copy-paste
setup guides for wiring that gateway into the coding assistants people actually
use, plus a ready-made Pi extension.

> These are best-effort guides. Tools, models, and endpoints change over time,
> so a step may drift out of date. If you hit an issue or error, ask the UvA or
> HvA AI chat about it, it is often the fastest way to get an answer.

## Get an API key

You need a key for the proxy before anything below works.

- Base URLs: `https://llmproxy.uva.nl` (UvA) or `https://llmproxy.hva.nl` (HvA)
- Getting a key: request one from your faculty IT / the proxy administrators.

Keep your key private. None of the guides below commit it to disk in plain text
beyond the tool's own secret storage or an environment variable you control.

## Pick your tool

| Tool | How it connects | Best for | Guide |
| --- | --- | --- | --- |
| **Claude Code** | Native Anthropic endpoint, env vars, zero config files | Fastest setup; Claude models | [claude-code/](claude-code/README.md) |
| **Pi** | Provider extension (handles every quirk) | All models + reasoning, terminal-native | [pi/](pi/README.md) |
| **VS Code (Copilot Chat)** | LiteLLM provider extension | In-editor chat inside the IDE you already use | [vscode/](vscode/README.md) |
| **OpenCode** | OpenAI-compatible provider | Terminal agent, config-file driven | [opencode/](opencode/README.md) |
| **Aider** | OpenAI-compatible env vars | Terminal pair-programming | [aider/](aider/README.md) |
| **Kilo Code** | Custom provider (chat / responses / anthropic) | VS Code agent, picks the right endpoint per model | [kilo-code/](kilo-code/README.md) |
| **Factory Droid** | BYOK custom models | Terminal agent, per-model endpoint control | [factory-droid/](factory-droid/README.md) |
| **Odysseus** | Self-hosted, OpenAI-compatible provider | A full self-hosted AI workspace | [odysseus/](odysseus/README.md) |

The Pi extension is published on npm, install it with `pi install npm:pi-uva-hva`
(full docs in [pi/](pi/README.md)).

Any other tool that speaks the OpenAI or Anthropic API can point at the proxy
too; see [opencode/](opencode/README.md) for the generic pattern.

## Which models are available

The line-up changes over time. To list what your key can reach right now:

Linux / macOS:

```bash
curl -s https://llmproxy.uva.nl/v1/models \
  -H "Authorization: Bearer YOUR_KEY" | jq '.data[].id'
```

Windows (PowerShell):

```powershell
(Invoke-RestMethod https://llmproxy.uva.nl/v1/models `
  -Headers @{ Authorization = "Bearer YOUR_KEY" }).data.id
```

Broadly: OpenAI GPT (`gpt-4o`, `gpt-4.1`, `gpt-5.x`), Anthropic Claude
(`claude-sonnet`, `claude-opus`, `claude-haiku`), and open-weight models
(`gpt-oss`, `Qwen`, `mistral`). Reasoning models (`gpt-5.x`, `o*`, Claude) accept
a thinking / `reasoning_effort` control.

## Good to know: endpoints

The proxy is LiteLLM, so it speaks several API shapes. Which one a tool uses
decides how smoothly reasoning + tools behave:

| Endpoint | Shape | Notes |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI chat | Works everywhere; but GPT reasoning models reject `reasoning_effort` together with tools here. |
| `/v1/responses` | OpenAI Responses | Where GPT/Claude reasoning + tools works. The Pi extension uses this. |
| `/v1/messages` | Anthropic Messages | Native Claude. What Claude Code uses. |
| `/v1/models`, `/model_group/info` | Discovery | Model list + real capabilities (context window, reasoning, cost). |

The per-tool guides note where this matters.

## Repo layout

```
.
├── README.md               this landing page
├── claude-code/            Claude Code (native Anthropic endpoint)
├── vscode/                 VS Code Copilot Chat (LiteLLM extension)
├── opencode/               OpenCode + generic OpenAI-compatible pattern
├── aider/                  Aider (terminal pair-programming)
├── kilo-code/              Kilo Code (VS Code agent)
├── factory-droid/          Factory Droid (BYOK)
├── odysseus/               Odysseus (self-hosted workspace)
└── pi/                     the Pi provider extension (installable package)
    ├── README.md           full Pi extension docs
    ├── index.ts
    └── package.json
```

## Contributing

Using the proxy with a tool that isn't covered here? Add a guide as a new
top-level folder (like the ones above) and link it from the table. Keep guides
short and copy-paste friendly.

## License

MIT. See [LICENSE](./LICENSE).
