# neon-bridge

Use **Gemini 4 Neon** as a second assistant inside [Claude Code](https://code.claude.com), or from any terminal, through **your own Gemini subscription**. It needs no API key and no API billing.

Claude gets a `gemini-neon` skill. It can ask Neon for second opinions, hold multi-turn discussions, send attachments, or let Neon investigate a folder on its own in a read-only **agent mode**.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Google or Anthropic. It automates the Gemini **web app** in a browser on your machine, which may conflict with Google's Terms of Service. Google can change or block this at any time, and automated use could put your account at risk. Use it at your own risk, for personal, low-volume use.

## How it works

```
Claude Code ──skill──▶ neon.js (CLI) ──HTTP, localhost only──▶ daemon ──CDP──▶ hidden Chrome
                                                                                 └─ dedicated profile, signed in to
                                                                                    your Google account → gemini.google.com
```

- A small daemon keeps a **headless Chrome** running with a **dedicated profile** that only this tool uses. It doesn't touch your normal browser or its cookies.
- For each request it selects the model in Gemini's picker (Neon by default), types the prompt, waits for the full reply, and converts it back to **markdown**.
- The daemon starts on demand and stops after 45 minutes idle.

## Features

| | |
|---|---|
| **One-shot questions** | `neon.js ask "..."` |
| **Multi-turn sessions** | `-s NAME` continues the same conversation, so Claude can push back and follow up |
| **Attachments** | `-a file` uploads code, PDFs, images and so on. Prompts over 20k characters are sent as a file automatically |
| **Agent mode** | `--agent DIR`: Neon can `LIST` / `READ` / `GREP` / `FIND` / `DEFS` (symbol definitions) and use read-only `GIT` (diff, log, show, blame, …) in that folder. Secret-like files (`.env`, keys, credentials, `.ssh`, …) are always blocked |
| **Run checks** | `--allow-run "npm test"`: Neon may also run that command (plus extra args) to check its ideas. Off by default; only the prefixes you allow |
| **Patches** | `--patch`: Neon proposes changes as a unified diff. It is checked with `git apply --check`, saved to a file, never applied, and sent back to Neon if it doesn't apply |
| **Clean history** | Chats are temporary by default. Use `--save` to keep one |
| **Other models** | `--model Hydrogen` (or `Carbon` if your plan includes it) |
| **Parallel** | Separate sessions can run at the same time |

## Requirements

- A Google account with a **Gemini plan that includes the model you want**. Neon currently needs Google AI Pro or Ultra.
- **Google Chrome** (Microsoft Edge or Chromium also work), on Windows, macOS or Linux
- **Node.js 18+** and npm
- Claude Code, if you want the skill. The CLI also works on its own.

## Install

### As a Claude Code plugin (recommended)

In Claude Code:
```
/plugin marketplace add Rahil-Maniar/neon-bridge
/plugin install neon-bridge@neon-bridge
```

Then run setup once in a terminal. It opens a browser window for you to sign in to Google. The plugin is installed under `~/.claude/plugins/cache/neon-bridge/neon-bridge/<version>/`. You can also simply ask Claude: *"run the neon-bridge setup"*. It will give you the exact command.
```
node ~/.claude/plugins/cache/neon-bridge/neon-bridge/<version>/bridge/neon.js setup
```

### Standalone (CLI only)
```
git clone https://github.com/Rahil-Maniar/neon-bridge
cd neon-bridge
npm install
node bridge/neon.js setup
```

**Setup** installs `playwright-core` if it's needed (it does not download a browser) and opens Chrome with the dedicated profile. You sign in, check that Gemini loads, and close the window. Setup then verifies that the model is selectable.

## Usage

In Claude Code, just ask:
- *"Ask Neon what it thinks of this migration plan."*
- *"Get a second opinion from Gemini on why this test is flaky."*
- *"Have Neon review the `src/auth` folder for bugs."* (agent mode)

From a terminal:
```
node bridge/neon.js ask "Explain the tradeoffs of optimistic vs pessimistic locking"
node bridge/neon.js ask -s design "Here's my plan: ..."  &&  node bridge/neon.js ask -s design "What would you cut?"
node bridge/neon.js ask -a report.pdf "Summarize the risks in this report"
node bridge/neon.js ask --agent ./my-repo "Find the most likely cause of the race condition in the job queue"
node bridge/neon.js ask --agent ./my-repo --allow-run "npm test" --patch "Fix the failing date parser test"
node bridge/neon.js doctor | sessions | end NAME | status | stop [--force]
```
Exit codes: `0` ok, `2` not set up or signed out, `3` model not available, `4` timed out or partial answer, `1` other.

## Configuration

Environment variables, or `config.json` in the bridge home:

| Env var | config.json | Default |
|---|---|---|
| `NEON_BRIDGE_HOME` | — | `~/.neon-bridge` (profile, logs, sessions, temp files) |
| `NEON_BROWSER` | `browserPath` | auto-detected Chrome, then Edge, then Chromium |
| `NEON_MODEL` | `model` | `Neon` |
| `NEON_CDP_PORT` / `NEON_API_PORT` | `cdpPort` / `apiPort` | `9333` / `9334` |
| `NEON_IDLE_MINUTES` | `idleMinutes` | `45` |

## Privacy and security

- **Your Google session lives in `~/.neon-bridge/profile`.** Treat that folder like a password: never share or commit it. `.gitignore` excludes it if it ends up inside the repo.
- Everything you send goes to Google under your account, **even temporary chats**. By default the skill tells Claude never to send login secrets, and to ask before sending sensitive third-party material. If you're comfortable sharing more, say so in your `CLAUDE.md`, for example: *"Sharing project material with Neon is pre-approved."*
- The daemon and the browser's debugging port listen on **127.0.0.1 only**. Note that any program running as you on the same machine could still talk to them.
- Agent mode is read-only and confined to the folder you pass it, unless you add `--allow-run`. Allowed commands run in that folder with your permissions, and running a project's tests executes its code, so allow only specific commands (`npm test`, not `npm`) on projects you trust. Patches are only ever checked, never applied.
- Tests for the agent tools: `npm test` (no browser or Google account needed).

## Troubleshooting

- **"Not set up" or "signed out":** run `setup` again.
- **Model not available:** check that your plan includes it (open gemini.google.com and look at the model picker), then run `doctor`.
- **It breaks after a Gemini redesign:** the page selectors are in the `SEL` object in `bridge/server.js`. `node bridge/server.js --show` runs the daemon with a visible window, and `bridge/dev/inspect.js` dumps the page's controls. PRs welcome.
- **Hangs:** run `stop --force` and try again. Logs are in `~/.neon-bridge/daemon.log`.

## License

MIT, see [LICENSE](LICENSE). "Gemini" is a trademark of Google LLC and "Claude" is a trademark of Anthropic; both are used here only to describe compatibility.
