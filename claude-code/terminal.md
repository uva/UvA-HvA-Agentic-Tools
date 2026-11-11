# Claude Code in the terminal, step by step

The [main Claude Code guide](./README.md) assumes `claude` already runs on your
machine. This page starts one step earlier: installing Claude Code, getting the
`claude` command to work, connecting it to the UvA / HvA proxy and using it
from a plain terminal, without VS Code or another editor.

The Windows steps use PowerShell. On Windows 11, right-click the Start button
and choose Terminal. macOS and Linux steps are at the end of each section.

## 1. Check whether it is already installed

```powershell
claude --version
```

If this prints a version number, skip to step 4. If PowerShell says `claude`
is not recognized, continue with step 2.

## 2. Install Claude Code

Windows (PowerShell, no administrator rights needed):

```powershell
irm https://claude.ai/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

The installer shows no progress while it downloads, so give it a minute. When
it is done, close the terminal, open a new one and run `claude --version`
again. If you get a version number, go to step 4.

[Git for Windows](https://git-scm.com/downloads/win) is optional. With it,
Claude Code runs commands through Git Bash; without it, it uses PowerShell.

## 3. If `claude` is still not found

On Windows the installer puts `claude.exe` in `%USERPROFILE%\.local\bin`. On
some machines that folder is not on your PATH yet, so the terminal cannot find
the command even though it is installed.

First check that the file is there:

```powershell
Test-Path "$env:USERPROFILE\.local\bin\claude.exe"
```

If this prints `True`, add the folder to your user PATH and try again:

```powershell
$bin = "$env:USERPROFILE\.local\bin"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$bin*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
}
$env:Path += ";$bin"
claude --version
```

This only changes the PATH for your own user account. New terminals pick it up
automatically.

If it prints `False`, the install did not finish or the file was removed
afterwards. See [Troubleshooting](#troubleshooting) below.

On macOS / Linux the binary lives in `~/.local/bin`. If `claude` is not found
there, add this line to `~/.bashrc` or `~/.zshrc` and open a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 4. Connect it to the UvA / HvA proxy

Set your proxy key and base URL as user environment variables. Use
`https://llmproxy.hva.nl` if you are at the HvA.

Windows (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://llmproxy.uva.nl", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "YOUR_PROXY_KEY", "User")
```

macOS / Linux (add to `~/.bashrc` or `~/.zshrc`):

```bash
export ANTHROPIC_BASE_URL="https://llmproxy.uva.nl"
export ANTHROPIC_AUTH_TOKEN="YOUR_PROXY_KEY"
```

Close the terminal and open a new one. Check that the variables are visible:

```powershell
$env:ANTHROPIC_BASE_URL
```

It should print the proxy URL. If it prints nothing, you are still in a
terminal that was open before you set the variables.

## 5. Start it in a project folder

Claude Code works in the folder you start it from, so go to your project
first:

```powershell
cd C:\path\to\your\project
claude
```

The first time, Claude Code asks whether you trust the folder. After that you
can type your question or task at the prompt. Pick a model with `/model`, for
example `claude-sonnet-4.5`. See [Choosing a model](./README.md#choosing-a-model)
for how to list what your key can reach.

## 6. Day-to-day use

Things you will use most:

| Action | How |
| --- | --- |
| Stop Claude while it is working | `Esc` |
| Switch permission mode (ask first, accept edits, plan) | `Shift+Tab` |
| Point at a file in your message | type `@` and the file name |
| Run a shell command yourself | start the line with `!` |
| Change model | `/model` |
| Write a `CLAUDE.md` with notes about the project | `/init` |
| Start fresh in the same session | `/clear` |
| Shrink a long conversation | `/compact` |
| Leave | `/exit` or `Ctrl+C` twice |
| Continue your last conversation in this folder | `claude -c` |
| Pick an older conversation | `claude --resume` |
| One question, no interactive session | `claude -p "explain what main.py does"` |

`/help` lists everything else.

## Troubleshooting

- `claude` is not recognized: the PATH step above. Remember to open a new
  terminal afterwards.
- `claude.exe` was there right after installing but is gone now: antivirus
  software sometimes quarantines it. Check which antivirus is active:

  ```powershell
  Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct |
    Select-Object -ExpandProperty displayName
  ```

  Restore the file from quarantine (or ask your IT department on a managed
  laptop), then run the installer again.
- Several versions installed, not sure which one runs: `claude doctor` shows
  the install location, version and any problems it finds.
- Claude Code asks you to log in with a Claude account: the environment
  variables from step 4 are not visible in this terminal. Open a new one and
  check with `$env:ANTHROPIC_BASE_URL`.
- 401 or 404 errors once it runs: see
  [Troubleshooting](./README.md#troubleshooting) in the main guide.
