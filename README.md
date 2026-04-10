# JellyGenie

**Voice-triggered autonomous agent powered by Claude Code.**

Say "genie" into a JellyJelly video. JellyGenie hears you, figures out what you want, and does it — builds sites, posts tweets, orders food, sends emails, creates Stripe payment links, books reservations. Results arrive on Telegram with screenshots and receipts. You never touch a keyboard.

## How it works

```
You record a JellyJelly clip → Deepgram transcribes it → JellyGenie detects "genie"
  → spawns a Claude Code subprocess with full tool access
  → Claude Code executes the wish (browse, build, deploy, research, order)
  → reports back on Telegram with links, screenshots, and receipts
```

JellyGenie runs two always-on macOS LaunchAgents:
1. **Chrome** (port 9222) — a persistent browser with your logged-in sessions (X, LinkedIn, Gmail, Uber Eats, Vercel, etc.)
2. **Server** — polls the JellyJelly API every 3s, detects the keyword, dispatches wishes

Each wish spawns a fresh `claude -p` subprocess with Playwright MCP attached to the persistent Chrome via CDP. The subprocess *is* the agent — it gets the full Claude Code toolbelt plus your logged-in browser sessions.

## Quick start

```bash
git clone https://github.com/iqramjelly/JellyGenie.git
cd JellyGenie
./setup.sh
```

The setup script walks you through everything interactively:
1. Checks prerequisites (Node 20+, Chrome, Claude CLI)
2. Installs npm dependencies
3. Prompts for your API keys (JellyJelly JWT, Telegram bot token, etc.)
4. Tests your Telegram connection
5. Installs LaunchAgents for Chrome and the server
6. Opens Chrome and prompts you to log into your accounts
7. Starts the server and confirms it's polling

Takes about 5 minutes including login time.

## Prerequisites

- **macOS** (uses launchd for persistent services)
- **Node.js 20+**
- **Google Chrome**
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **A JellyJelly account** (for the firehose API)
- **A Telegram bot** (for receiving results)

## Architecture

```
src/
  core/
    server.mjs           # polls JellyJelly firehose, detects keyword, dispatches
    dispatcher.mjs       # spawns claude -p, streams events, reports to Telegram + JellyJelly chat
    firehose.mjs         # JellyJelly API client
    telegram.mjs         # Telegram bot wrapper
    jelly-chat.mjs       # JellyJelly WebSocket chat (posts plan + results to clip threads)
    dispatch-registry.mjs # persistent wish tracking (dedup, retry, cancel)
config/
    genie-system.md      # system prompt for spawned Claude Code instances
    mcp.json             # Playwright MCP config (CDP → localhost:9222)
examples/
    *.plist              # LaunchAgent templates
skills/
    ubereats-*           # Uber Eats ordering skills for Claude Code
```

## Configuration

All config lives in `.env` (created by `setup.sh`). Key variables:

| Variable | Required | Description |
|---|---|---|
| `JELLY_AUTH_TOKEN` | Yes | JellyJelly JWT (from browser cookies) |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram user ID |
| `JELLYGENIE_OWNER_NAME` | No | Your name (used in outreach messages) |
| `GENIE_CLAUDE_MODEL` | No | `sonnet` (default) or `opus` |
| `GENIE_MAX_TURNS` | No | Max Claude Code turns per wish (default: 200) |
| `GENIE_MAX_BUDGET_USD` | No | Max spend per wish (default: $25) |
| `OPENROUTER_API_KEY` | No | Enables free-model fallback mode |
| `STRIPE_SECRET_KEY` | No | Enables payment link wishes |

## Commands

```bash
# Start/stop services
launchctl load -w ~/Library/LaunchAgents/com.jellygenie.server.plist
launchctl unload ~/Library/LaunchAgents/com.jellygenie.server.plist

# View logs
tail -f /tmp/jellygenie-logs/launchd.out.log

# Resume a killed wish
grep "session=" /tmp/jellygenie-logs/launchd.out.log | tail -5
claude -p "Continue..." --resume <session-id> --mcp-config config/mcp.json --permission-mode bypassPermissions

# Develop with Claude Code
cd JellyGenie && claude
```

## Developing

Open the repo in Claude Code (`cd JellyGenie && claude`) — the CLAUDE.md bootstraps everything automatically, including health checks and auto-fix.

The codebase is pure Node.js (ESM) with no build step. Edit, save, restart the server launchd agent.

## License

MIT
