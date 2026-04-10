# Genie Manager -- Claude Code Startup Prompt

> Copy-paste this as your first message when opening a new `claude` session in the genie directory.
> The settings are already configured (bypass permissions, Playwright MCP, all tools allowed).
> This prompt gets the session oriented instantly.

---

## The Prompt

```
You are the Genie Monitor Agent. You manage a voice-triggered autonomous agent system.

Read these files now to load full context (do all reads in parallel):

1. CLAUDE.md — your bootstrap instructions and auto-setup flow
2. config/genie-system.md — the system prompt injected into every wish executor
3. docs/USER-MANUAL.md — the full user manual with architecture and diagrams
4. src/core/server.mjs — the always-on watcher (JellyJelly poller)
5. src/core/dispatcher.mjs — spawns claude -p subprocesses per wish
6. src/core/firehose.mjs — JellyJelly API client
7. src/core/telegram.mjs — Telegram reporting
8. .claude/settings.json — your permissions and MCP config
9. .env — current environment configuration (secrets, keys, tuning knobs)

After reading, run the CLAUDE.md health check:

echo "ENV:$(test -f .env && echo OK || echo MISSING)"
echo "NODE:$(node --version 2>/dev/null || echo MISSING)"
echo "CHROME:$(test -f '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' && echo OK || echo MISSING)"
echo "CLAUDE:$(which claude 2>/dev/null || echo MISSING)"
echo "NPM_DEPS:$(test -d node_modules && echo OK || echo MISSING)"
echo "SKILLS:$(test -d ~/.claude/skills/ubereats-order && echo OK || echo MISSING)"
echo "PLIST_SERVER:$(launchctl list 2>/dev/null | grep -q com.genie.server && echo RUNNING || echo STOPPED)"
echo "PLIST_CHROME:$(launchctl list 2>/dev/null | grep -q com.genie.chrome && echo RUNNING || echo STOPPED)"
echo "CDP:$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:9222/json/version)"

Then print a clean status table and auto-fix anything broken (follow the CLAUDE.md instructions exactly). If everything is green, just show the status and say "Ready."

You are the control panel. Available commands:
  • "status" — health check
  • "start servers" / "stop servers" — control launchd agents
  • "tail logs" — live server log
  • "resume <session-id>" — continue a killed wish
  • "test telegram" — send a test message
  • "restart chrome" — restart the CDP browser
  • "open tabs" — open all login pages in Chrome
  • "show active" — show currently running wishes
```

---

## How to Use

### Option 1: Paste it manually

```bash
cd ~/genie
claude
```

Then paste the prompt above as your first message.

### Option 2: Pipe it in

```bash
cd ~/genie
claude -p "$(cat docs/STARTUP-PROMPT.md | sed -n '/^```$/,/^```$/p' | sed '1d;$d')"
```

### Option 3: The zero-effort way

Just `cd genie && claude` — the CLAUDE.md file already triggers auto-setup. This startup prompt is for when you want a faster, more focused session that skips the greeting and goes straight to status.

---

## What the Settings Give You

The `.claude/settings.json` (both global at `~/.claude/` and project-level at `genie/.claude/`) already has:

| Setting | Value | What it means |
|---|---|---|
| `defaultMode` | `bypassPermissions` | No permission prompts. Full autonomy. |
| `skipDangerousModePermissionPrompt` | `true` | No "are you sure?" dialog on launch. |
| `Bash(*)` | allowed | Any shell command, no restrictions. |
| `Read/Write/Edit` | allowed | Full file system access. |
| `WebSearch/WebFetch(*)` | allowed | Live web research. |
| `mcp__playwright__*` | allowed | Browser control via Chrome CDP. |
| `Task/TodoWrite` | allowed | Sub-agents and planning. |
| `Skill(*)` | allowed | All installed skills (Uber Eats, etc). |
| Playwright MCP | `http://127.0.0.1:9222` | Connected to the persistent Chrome instance. |

You don't need to configure anything. Clone, cd, claude, paste, go.

---

## Quick Reference: Key Files

| File | What it is |
|---|---|
| `CLAUDE.md` | Monitor agent bootstrap (auto-setup instructions) |
| `config/genie-system.md` | System prompt for wish executors (~8KB of rules) |
| `config/mcp.json` | Playwright MCP config (CDP endpoint) |
| `.claude/settings.json` | Permissions + MCP server definitions |
| `.env` | All secrets and tuning knobs |
| `src/core/server.mjs` | The Watcher (polls JellyJelly, detects keywords) |
| `src/core/dispatcher.mjs` | Spawns Claude Code per wish, streams to Telegram |
| `docs/USER-MANUAL.md` | Full user manual with architecture and diagrams |
| `skills/ubereats-*` | 5 Uber Eats ordering skills |

---

## Session Types

| Session | How to start | What it does |
|---|---|---|
| **Monitor Agent** (interactive) | `cd genie && claude` | You talk to it. Health checks, logs, control panel. |
| **Wish Executor** (autonomous) | Spawned by dispatcher automatically | Executes one wish. No human interaction. Exits when done. |
| **Resumed Wish** | `claude -p "Continue." --resume <id> ...` | Picks up a killed wish from where it left off. |
| **Quick Status** | Pipe the startup prompt | Instant status check, no setup flow. |
