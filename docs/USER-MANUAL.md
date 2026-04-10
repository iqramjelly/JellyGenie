# Genie User Manual

> You wished for it. Genie makes it real.

---

## 1. What Is Genie?

Genie is a voice-triggered AI agent. You stand in front of a JellyJelly camera, say the word "genie," and a full-blown AI assistant wakes up in the background and does whatever you asked for. Build a website. Post a tweet. Create a Stripe payment link. Order food on Uber Eats. Research a topic and send you a summary. It handles the whole thing, start to finish, without you ever touching a keyboard.

The key design choice is that Genie is **one-way**. You cannot message it. You cannot type at it. You can only *wish*. You speak into the camera, and results show up on your phone via Telegram -- a live URL, a screenshot, a payment link, a confirmation. That's the entire interface: camera in, Telegram out. Every wish gets a fresh AI agent that spins up, does its job, sends you a receipt, and disappears.

Under the hood, Genie is powered by Claude Code -- Anthropic's CLI tool for autonomous coding and task execution. Instead of writing custom code for every possible wish type, Genie just pipes your spoken words into a Claude Code subprocess and lets it figure out what to do. It has access to a web browser where you're already logged into everything, a Vercel account for deploying sites, a Stripe account for creating payment links, and web search for researching anything. If Claude Code can do it, Genie can do it.

---

## 2. The Two Brains

Genie has two distinct "brains" that do very different jobs. Think of them as **ears** and **hands**.

### The Watcher (the ears)

The Watcher is an always-on Node.js process (`server.mjs`) that runs in the background via macOS launchd (like a system service). Every 3 seconds, it polls the JellyJelly API asking: "Any new video clips?" When it finds one, it checks whether the audio transcript contains the magic word -- "genie" by default. If the transcript isn't ready yet (JellyJelly uses Deepgram for speech-to-text, and that takes a few seconds), the Watcher enters a fast-retry mode, checking that specific clip every 1.5 seconds until the words arrive.

The Watcher never executes wishes. It only listens. When it hears the keyword, it hands the transcript off to the Dispatcher and goes back to listening.

### The Executor (the hands)

When the Watcher detects "genie," the Dispatcher (`dispatcher.mjs`) spawns a brand-new `claude -p` subprocess. This is a fresh Claude Code instance with a 200-turn budget, a $25 spend cap, and access to every tool it needs: shell commands, file operations, web search, a pre-logged-in Chrome browser (via Playwright MCP), Vercel for deploys, and Stripe for payments.

This subprocess is fully autonomous. It reads the transcript, makes a plan, executes each step, reports progress to Telegram along the way, and sends a final receipt when it's done. Then it exits and is gone. Every wish gets its own executor -- they don't share state, they don't interfere with each other.

**Concurrent wishes:** As of the latest update, Genie can run up to 5 wishes at the same time (configurable via `GENIE_MAX_CONCURRENT`). If more wishes come in while 5 are running, they queue up and run as slots free. Each concurrent wish gets its own browser tab -- there's a "tab isolation" rule in the system prompt that tells each executor to open a new tab and never touch other tabs.

---

## 3. Architecture Diagram

```
    YOU (speaking into a camera)
         |
         v
  +----------------+
  |   JellyJelly   |   Video platform with Deepgram
  |   Camera/App   |   speech-to-text transcription
  +-------+--------+
          |
          | (clips with word-level transcripts)
          v
  +-------+--------+
  |   WATCHER       |   server.mjs (always-on, launchd)
  |                 |
  |  Poll every 3s  |   Calls JellyJelly API via firehose.mjs
  |  Fast-retry 1.5s|   for clips without transcripts yet
  |                 |
  |  Keyword scan:  |   containsKeyword() checks each word
  |  "genie" found? |   in the Deepgram transcript
  +-------+---------+
          |
          | YES -- keyword detected
          v
  +-------+---------+
  |   DISPATCHER    |   dispatcher.mjs
  |                 |
  |  Builds prompt  |   Combines transcript + system prompt
  |  Spawns claude  |   from config/genie-system.md
  |  -p subprocess  |
  |                 |
  |  Streams events |   Parses stream-json output line by
  |  to Telegram    |   line, throttled to every 3s
  +-------+---------+
          |
          v
  +-------+---------+
  |   CLAUDE CODE   |   Autonomous AI subprocess
  |   (executor)    |   Sonnet model, 200 turns, $25 cap
  |                 |
  |  Tools:         |
  |  +-- Bash       |   Shell commands, curl, file ops
  |  +-- Browser    |   Playwright MCP -> Chrome CDP :9222
  |  +-- Vercel     |   Deploy sites to production URLs
  |  +-- Stripe     |   Payment links & invoices
  |  +-- WebSearch  |   Live web research
  |  +-- WebFetch   |   Download pages & data
  |  +-- Task       |   Spawn parallel sub-agents
  +-------+---------+
          |
          | Progress updates + final receipt
          v
  +-------+---------+
  |   TELEGRAM BOT  |   telegram.mjs
  |   (one-way)     |
  |                 |
  |  sendMessage()  |   Text updates, URLs, receipts
  |  sendPhoto()    |   Screenshots of deployed sites
  +-------+---------+
          |
          v
     YOUR PHONE
     (buzzes with results)
```

---

## 4. Wish Lifecycle (Step by Step)

Here's what happens from the moment you open your mouth to the moment your phone buzzes.

**Step 1: You record a video (0s)**
You open JellyJelly, face the camera, and say something like: "Genie, build me a site for my consulting business and make a Stripe checkout for $500." You post the clip.

**Step 2: JellyJelly transcribes (5-30s)**
JellyJelly sends the audio through Deepgram, which produces a word-level transcript. This can take anywhere from 5 to 30 seconds depending on clip length.

**Step 3: Watcher picks up the clip (~3s after posting)**
`server.mjs` is polling the JellyJelly search API every 3 seconds via `firehose.mjs`. It sees the new clip. If the transcript isn't ready yet, it spawns a fast-retry watcher that checks every 1.5 seconds (up to 5 minutes) until words appear.

**Step 4: Keyword detection (~0s once transcript arrives)**
`firehose.mjs` scans every word in the Deepgram transcript, checking both raw and punctuated forms (case-insensitive). It finds "genie." The Watcher marks this clip as seen so it won't process it again.

**Step 5: Telegram notification (~1s)**
The Watcher sends a heads-up to Telegram: "Genie heard 'genie' in clip X. Spawning Claude Code..."

**Step 6: Dispatcher spawns Claude Code (~2-5s to start)**
`dispatcher.mjs` builds a user prompt containing the full transcript, clip metadata, and instructions. It reads the system prompt from `config/genie-system.md` (~7KB of rules). It spawns `claude -p` with bypass permissions, 200-turn limit, $25 budget, and stream-json output.

**Step 7: Claude Code makes a plan (~5-10s)**
The executor writes a TodoWrite plan -- a numbered checklist. It sends this plan to Telegram so you can see what's coming. Example: "Plan: (1) research topic, (2) download images, (3) build HTML, (4) create Stripe link, (5) deploy to Vercel, (6) send receipt."

**Step 8: Execution (30s to 15min depending on complexity)**
Claude Code works through its plan. It might:
- Run `WebSearch` and `WebFetch` to gather real information
- Use `Bash` to download images and write HTML files
- Call the Stripe CLI to create products, prices, and payment links
- Run `npx vercel deploy --prod` to push a site live
- Drive the pre-logged-in Chrome via Playwright MCP to post tweets, send LinkedIn messages, or fill out forms
- Spawn parallel sub-agents via the `Task` tool for independent work

Throughout this, the Dispatcher forwards tool-use summaries to Telegram every 3 seconds.

**Step 9: Final receipt (~1s)**
Claude Code sends a structured "GENIE RECEIPT" to Telegram listing: what the wish was, what it did (with URLs), what failed (if anything), and timing/cost stats.

**Step 10: Cleanup (~1s)**
The Dispatcher logs the exit code, total turns, and cost. It sends a footer to Telegram: "Done in 112s, 18 turns, $0.73." The subprocess exits and is gone.

**Total time:** 1-3 min for simple wishes (tweet, message). 3-8 min for medium wishes (build + deploy a site). Up to 15 min for complex multi-step wishes.

---

## 5. The Monitor Agent (Claude Code Interactive Session)

There's a third "brain" that doesn't show up in the architecture diagram because it's *you*. When you open a terminal, `cd` into the genie directory, and run `claude`, Claude Code reads the `CLAUDE.md` file and becomes the **Monitor Agent**.

The Monitor Agent is an interactive Claude Code session that acts as Genie's control panel. It's completely separate from the wish-executor agents that spawn per wish:

- **Wish executors** are autonomous. They're spawned by the Dispatcher, run unattended, do their job, and exit. You never interact with them directly.
- **The Monitor Agent** is you, in a terminal, talking to Claude Code. It's interactive. You can ask it questions, give it commands, and watch it work.

When the Monitor Agent starts up, it automatically runs a health check: are the env vars set? Is Chrome running with CDP? Is the Genie server polling? Are the launchd agents loaded? Are Uber Eats skills installed? It shows you a status table and auto-fixes anything that's broken.

After setup, the Monitor Agent serves as your dashboard. You can say:
- **"status"** -- run a health check
- **"tail logs"** -- watch the server output in real time
- **"start servers"** / **"stop servers"** -- control the launchd agents
- **"resume abc123"** -- pick up a wish that got killed mid-execution

The key insight: `CLAUDE.md` and `.claude/settings.json` are pre-configured so that cloning the repo and running `claude` gives you full permissions, MCP connected, no dialogs. The Monitor Agent bootstraps itself.

---

## 6. Component Map

| File | What It Does | Brain |
|---|---|---|
| `src/core/server.mjs` | Always-on poll loop. Checks JellyJelly every 3s. Triggers Dispatcher when keyword found. | Watcher |
| `src/core/firehose.mjs` | JellyJelly API client. Polling, clip details, transcript reconstruction, keyword detection. | Watcher |
| `src/core/dispatcher.mjs` | Spawns `claude -p` subprocesses. Builds prompts. Streams JSON events to Telegram. | Watcher → Executor |
| `src/core/telegram.mjs` | One-way Telegram bot wrapper. `sendMessage()` for text, `sendPhoto()` for screenshots. | Shared |
| `config/genie-system.md` | 7KB system prompt injected into every spawned Claude Code. Teaches it the Genie rules. | Executor |
| `config/mcp.json` | Playwright MCP config. Points at Chrome CDP port 9222. | Executor |
| `.claude/settings.json` | Pre-configured permissions: bypass mode, Playwright MCP, all tools allowed. | Monitor |
| `CLAUDE.md` | Instructions for the Monitor Agent. Defines auto-setup flow and available commands. | Monitor |
| `src/core/memory.mjs` | Per-user wish history tracking. | Watcher |
| `scripts/start-browser.sh` | Shell script to load/unload/restart the Chrome launchd agent. | Setup |
| `examples/*.plist` | LaunchAgent templates for Chrome and the Genie server. | Setup |
| `skills/ubereats-*` | 5 Uber Eats skills (search, add-to-cart, checkout, pay, orchestrator). | Executor |

---

## 7. Prerequisites (What You Need Before Starting)

- **macOS** -- Genie uses LaunchAgents to keep services running in the background. Mac-only out of the box.
- **Node.js 20+** -- The server and helpers are JavaScript. Check with `node --version`.
- **Google Chrome** -- Installed at `/Applications/Google Chrome.app`. Genie launches a separate Chrome instance with its own profile for browsing on your behalf.
- **Claude Code CLI** -- Anthropic's command-line tool. The brain that executes every wish. Install: `npm install -g @anthropic-ai/claude-code`.
- **A Telegram bot + your chat ID** -- How Genie reports back to you. Create a bot via @BotFather (2 minutes). Find your chat ID by messaging @userinfobot.
- **Stripe CLI** (optional) -- For payment links/invoices. Install: `brew install stripe/stripe-cli/stripe`.
- **Vercel CLI** (optional) -- For deploying websites. Run `npx vercel login` once.
- **A JellyJelly account** -- The camera app where you record wishes.

---

## 8. Setup (Step by Step)

### The easy path (recommended)

```bash
git clone https://github.com/gtrush03/genie.git
cd genie
claude
```

That's it. Claude Code reads `CLAUDE.md` and becomes the installer:

1. **Silent health check** -- Checks Node, Chrome, npm deps, LaunchAgents, Chrome CDP, `.env`, and skills.
2. **Status report** -- Prints a table: green for working, red for missing.
3. **Auto-fixes everything broken** -- `npm install`, copies skills, installs LaunchAgents, starts Chrome CDP, creates `.env` and walks you through Telegram credentials, starts the server.
4. **Browser logins** -- Opens Chrome with tabs for X, LinkedIn, Gmail, Uber Eats, Vercel, GitHub, Stripe, and more. Log into each one with "Keep me signed in."
5. **Final verification** -- Confirms everything is running. You're ready.

Takes about 5 minutes, mostly spent logging into websites.

### The manual path

```bash
git clone https://github.com/gtrush03/genie.git
cd genie
bash setup.sh
```

Same steps as above but through a traditional shell script.

---

## 9. Your First Wish

1. **Record the clip (~10s)** -- Open JellyJelly. Say: *"Genie, build me a landing page for my dog walking business called Happy Paws."* Post it.

2. **JellyJelly transcribes (~5-30s)** -- Deepgram processes your audio into words.

3. **Genie detects the keyword (~3-6s)** -- The Watcher finds "genie" in the transcript. Your phone buzzes: *"Genie heard 'genie' in your clip. Spawning Claude Code..."*

4. **Claude Code wakes up (~5-10s)** -- Fresh subprocess with your transcript, system prompt, browser access, and all tools.

5. **It gets to work (~60-180s)** -- Researches dog walking businesses, writes HTML, downloads imagery, deploys to Vercel, takes a screenshot. Tool-use updates trickle into Telegram.

6. **Receipt lands on Telegram** -- Screenshot of the live site, the public URL (`https://genie-happy-paws.vercel.app`), and a summary: *"Done in 112s, 18 turns, $0.73."*

**Total: roughly 90 seconds to 3 minutes.**

---

## 10. Configuration & Knobs

All config lives in `.env` in the project root.

### Essential

| Variable | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token (from @BotFather). How Genie talks to you. |
| `TELEGRAM_CHAT_ID` | Your numeric Telegram chat ID. Where all messages go. |

### Dispatcher

| Variable | Default | What it does |
|---|---|---|
| `GENIE_CLAUDE_MODEL` | `sonnet` | Which Claude model. `sonnet` = fast/cheap. `opus` = smarter/slower. |
| `GENIE_MAX_TURNS` | `200` | Max tool-use turns per wish. |
| `GENIE_MAX_BUDGET_USD` | `25` | Max dollar spend per wish. Safety cap. |
| `GENIE_CLAUDE_TIMEOUT_MS` | `3600000` | Hard timeout (60 min). Set `0` to disable. |

### Firehose

| Variable | Default | What it does |
|---|---|---|
| `GENIE_KEYWORD` | `genie` | The magic word. Change to anything you want. |
| `GENIE_POLL_INTERVAL` | `3000` | How often (ms) to check JellyJelly. |
| `GENIE_FAST_RETRY_INTERVAL` | `1500` | How often (ms) to re-check a clip with no transcript yet. |
| `GENIE_FAST_RETRY_MAX_MS` | `300000` | Max wait (5 min) for a transcript. |
| `GENIE_WATCHED_USERS` | (empty) | Watch specific JellyJelly users. Empty = everyone. |
| `GENIE_MAX_CONCURRENT` | `5` | Max wishes running at the same time. Extras queue up. |

### Deploy

| Variable | What it does |
|---|---|
| `GH_OWNER` | Your GitHub username. Used for Vercel deploy URLs. |

### Payments

| Variable | What it does |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key. `sk_test_...` for testing, `sk_live_...` for real. |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key. |

### Browser

| Variable | Default | What it does |
|---|---|---|
| `GENIE_BROWSER_PROFILE` | `~/.genie/browser-profile` | Where Chrome stores cookies and logins. |
| `GENIE_CDP_ENDPOINT` | `http://127.0.0.1:9222` | Chrome DevTools Protocol endpoint. |

---

## 11. Common Commands

| What you want to do | Command |
|---|---|
| Start both services | `launchctl load -w ~/Library/LaunchAgents/com.genie.chrome.plist && launchctl load -w ~/Library/LaunchAgents/com.genie.server.plist` |
| Stop both services | `launchctl unload ~/Library/LaunchAgents/com.genie.server.plist && launchctl unload ~/Library/LaunchAgents/com.genie.chrome.plist` |
| Check if services are running | `launchctl list \| grep genie` |
| Check Chrome CDP | `curl -s http://127.0.0.1:9222/json/version` |
| Tail server logs | `tail -f /tmp/genie-logs/launchd.out.log` |
| Tail error logs | `tail -f /tmp/genie-logs/launchd.err.log` |
| Resume a killed wish | `grep "session=" /tmp/genie-logs/launchd.out.log \| tail -5` then `claude -p "Continue." --resume <session-id> --mcp-config config/mcp.json --permission-mode bypassPermissions --max-turns 200` |
| Test Telegram | `source .env && curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${TELEGRAM_CHAT_ID}" -d text="Test"` |
| Restart Chrome | `./scripts/start-browser.sh restart` |
| Trigger a clip manually | `node src/core/trigger.mjs <clip-id>` |
| Full health check | `cd genie && claude` (runs automatically) |

---

## 12. Troubleshooting

### Chrome CDP not responding

`curl http://127.0.0.1:9222/json/version` returns nothing or "connection refused."

1. Check if Chrome is running: `launchctl list | grep com.genie.chrome`
2. Start it: `launchctl load -w ~/Library/LaunchAgents/com.genie.chrome.plist`
3. Wait 5-8 seconds (cold start is slow), try again.
4. If port is grabbed by something else: `lsof -nP -iTCP:9222 -sTCP:LISTEN`
5. If "another instance using profile" error, clear locks:
   ```
   rm -f ~/.genie/browser-profile/SingletonLock ~/.genie/browser-profile/SingletonSocket ~/.genie/browser-profile/SingletonCookie
   ```

### Server crash-looping

1. Check: `tail -20 /tmp/genie-logs/launchd.err.log`
2. Most common cause: `.env` missing or `TELEGRAM_BOT_TOKEN` not set.
3. After fixing, restart: `launchctl unload ~/Library/LaunchAgents/com.genie.server.plist && launchctl load -w ~/Library/LaunchAgents/com.genie.server.plist`

### Telegram not sending

1. Test: `source .env && curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
2. If error: token is wrong. Get a fresh one from @BotFather.
3. Make sure `TELEGRAM_CHAT_ID` is a number (message @userinfobot to confirm).
4. Make sure you've sent at least one message to your bot first -- bots can't message you until you message them.

### Wish starts but does nothing

1. Check Claude Code auth: `claude -p "echo ok" --output-format text`
2. Check logs: `tail -50 /tmp/genie-logs/launchd.out.log`
3. Verify `config/genie-system.md` exists.

### Browser sessions expired

Open the Genie Chrome window, navigate to the expired site, log in again with "Keep me signed in." No restart needed.

---

## 13. Security Notes

- **`.env` has real secrets.** API keys, bot tokens, Stripe keys. It's gitignored but treat it like a password file.
- **Browser profile has your cookies.** `~/.genie/browser-profile` holds active sessions for every logged-in site. Protect it.
- **`bypassPermissions` = full autonomy.** Claude Code can run any shell command and write any file without asking. Only run on your own machine.
- **Telegram is your only window.** If something unexpected happens, you'll see it there. Keep notifications on.

---

## 14. Skills (Uber Eats + Custom)

### What are skills?

Skills are instruction files (markdown) that teach Claude Code specific workflows. They live at `~/.claude/skills/` and are auto-discovered when relevant.

### The 5 Uber Eats skills

| Skill | What it does |
|---|---|
| `ubereats-order` | Orchestrator. Parses your wish into a shopping list, calls the other 4 in sequence. |
| `ubereats-search` | Searches Uber Eats for stores/items. Handles the overlay UI quirk. |
| `ubereats-add-to-cart` | Navigates stores, handles modals, quantity pickers, substitutions. |
| `ubereats-checkout` | Reviews cart, verifies address/payment, screenshots the total. |
| `ubereats-pay` | Places the order, captures confirmation, sends receipt to Telegram. |

### Adding custom skills

1. Create a folder: `skills/my-skill/`
2. Add a `SKILL.md` with YAML frontmatter (`name`, `description` with trigger phrases)
3. Write instructions in plain English below the frontmatter
4. Install: `cp -r skills/my-skill ~/.claude/skills/`

---

*Made by saying words into a camera.* 🎙️ → 🧞 → 📱
