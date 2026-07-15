# Odysseus + UvA / HvA proxy

[Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) is a self-hosted AI
workspace: chat, agents, deep research, documents, email, notes, and calendar,
with local and API models. You run it yourself (Docker or native) and open it in
the browser. It can talk to OpenAI-compatible endpoints, so the proxy plugs in as
a provider.

Because Odysseus is self-hosted and configured in-app, the exact screens vary by
version. This guide covers the reliable path and links to the official docs;
treat the base URL and key below as the values to enter wherever Odysseus asks
for a provider.

## Install Odysseus

From the project [Quick Start](https://github.com/pewdiepie-archdaemon/odysseus):

Linux / macOS:

```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

Windows (PowerShell), with Docker Desktop running:

```powershell
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
Copy-Item .env.example .env
docker compose up -d --build
```

Open `http://localhost:7000` once the containers are healthy. The first admin
password is printed in the logs:

```bash
docker compose logs odysseus
```

Native, GPU, Windows, and macOS instructions are in the official
[setup guide](https://github.com/pewdiepie-archdaemon/odysseus/blob/dev/docs/setup.md).

## Connect the proxy

Odysseus adds providers from inside the app. After you log in, either type
`/setup` in the chat or open Settings and add an AI endpoint, then supply:

- Provider type: OpenAI-compatible (Odysseus connects to Ollama, vLLM, and
  other OpenAI-compatible endpoints the same way)
- Base URL: `https://llmproxy.uva.nl/v1` (or `https://llmproxy.hva.nl/v1`)
- API key: your proxy key

Once saved, the proxy's models become selectable in chat and agents.

### Recommended default: cheap SURF models

Odysseus runs a lot of model calls in the background (email triage and
summaries, research steps, note and task automation, chat). Those add up on the
commercial models, so default to the cheap open-weight models hosted on SURF
and keep the pricier GPT / Claude models for the hard problems.

Set your default model to one of these (all low-cost, served through the same
OpenAI-compatible endpoint above):

| Model id | Notes |
| --- | --- |
| `Qwen3.6` | Recommended default: capable general model, very cheap |
| `gpt-oss-120b` | Larger open-weight option |
| `mistral-small-3.2` | Fast and light |

In Odysseus, pick `Qwen3.6` as the model for chat and for any scheduled or
agentic tasks, and only switch a specific conversation to a GPT or Claude model
when you need the extra capability. This keeps day-to-day usage cheap while the
strong models stay one click away.

### Finding model ids

To see everything your key can reach (the list changes over time):

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

## Notes

- Self-hosted trust: Odysseus has powerful local tools (shell, files, MCP).
  Keep authentication enabled and do not expose the port publicly. See the
  project's `SECURITY.md`.
- Endpoint behaviour: the OpenAI-compatible provider uses
  `/v1/chat/completions`. That is fine for chat and Claude models; OpenAI GPT
  reasoning models (`gpt-5.x`) can reject `reasoning_effort` together with tool
  calls on that endpoint. If you hit that in an agent flow, use a Claude or a
  non-reasoning model, or drive those models through [Pi](../pi/README.md).
- Corporate TLS: if your setup uses an internal CA, Odysseus supports an
  extra CA bundle via `LLM_CA_BUNDLE` in `.env`.

## Troubleshooting

- Endpoint shows offline: confirm the base URL is reachable and ends in
  `/v1`, and that the key is correct.
- No models listed: enter model ids by hand from the `curl` output above.
- First login: the admin password is only in `docker compose logs odysseus`
  on first boot.
