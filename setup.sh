#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# JellyGenie — Interactive setup for macOS
# Run once after cloning:  chmod +x setup.sh && ./setup.sh
# Idempotent: safe to run multiple times.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
info() { echo -e "${CYAN}→${RESET} $1"; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
SKILLS_SRC="$HOME/.claude/skills"
LOG_DIR="/tmp/jellygenie-logs"
GENIE_HOME="$HOME/.jellygenie"

echo ""
echo -e "${BOLD}🧞 JellyGenie Setup${RESET}"
echo "────────────────────────────────────────"
echo -e "${DIM}Voice-triggered autonomous agent powered by Claude Code${RESET}"
echo ""

# ── Step 1: Prerequisites ────────────────────────────────────────────────────
info "Checking prerequisites..."

if [[ "$(uname)" != "Darwin" ]]; then
  fail "macOS required. Detected: $(uname)"; exit 1
fi
ok "macOS ($(uname -m))"

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install: https://nodejs.org (v20+)"; exit 1
fi
NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VER" -lt 20 ]]; then
  fail "Node 20+ required. Found: $(node --version)"; exit 1
fi
ok "Node $(node --version)"

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  fail "Google Chrome not found at /Applications/Google Chrome.app"; exit 1
fi
ok "Google Chrome installed"

if ! command -v claude &>/dev/null; then
  warn "Claude CLI not found."
  read -rp "  Install it now with npm? [Y/n] " yn
  if [[ "${yn:-Y}" =~ ^[Yy]?$ ]]; then
    npm install -g @anthropic-ai/claude-code
    ok "Claude CLI installed"
  else
    fail "Claude CLI is required. Install: npm install -g @anthropic-ai/claude-code"; exit 1
  fi
else
  ok "Claude CLI ($(which claude))"
fi

echo ""

# ── Step 2: npm install ──────────────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$REPO_DIR"
npm install --silent 2>&1 | tail -1
ok "npm dependencies installed"

echo ""

# ── Step 3: Stripe CLI (optional) ────────────────────────────────────────────
if command -v stripe &>/dev/null; then
  ok "Stripe CLI already installed"
else
  if command -v brew &>/dev/null; then
    read -rp "Install Stripe CLI via Homebrew? (enables payment wishes) [y/N] " yn
    if [[ "${yn}" =~ ^[Yy]$ ]]; then
      brew install stripe/stripe-cli/stripe 2>/dev/null && ok "Stripe CLI installed" || warn "Stripe CLI install failed (non-fatal)"
    else
      warn "Skipping Stripe CLI — payment wishes won't work"
    fi
  else
    warn "Stripe CLI not found and Homebrew not available — skipping"
  fi
fi

echo ""

# ── Step 4: Interactive .env setup ───────────────────────────────────────────
if [[ -f "$REPO_DIR/.env" ]]; then
  ok ".env already exists"
  read -rp "  Reconfigure it? [y/N] " yn
  if [[ ! "${yn}" =~ ^[Yy]$ ]]; then
    echo "  Keeping existing .env"
  else
    rm "$REPO_DIR/.env"
  fi
fi

if [[ ! -f "$REPO_DIR/.env" ]]; then
  info "Setting up your configuration..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  sed -i '' "s|/Users/you|$HOME|g" "$REPO_DIR/.env"

  echo ""
  echo -e "${BOLD}Let's configure JellyGenie. I'll walk you through each key.${RESET}"
  echo -e "${DIM}Press Enter to skip optional fields.${RESET}"
  echo ""

  # Helper: set a key in .env
  set_env() {
    local key="$1" value="$2"
    if [[ -n "$value" ]]; then
      if grep -q "^${key}=" "$REPO_DIR/.env"; then
        sed -i '' "s|^${key}=.*|${key}=${value}|" "$REPO_DIR/.env"
      else
        echo "${key}=${value}" >> "$REPO_DIR/.env"
      fi
    fi
  }

  # ── Required: JellyJelly ──
  echo -e "${BOLD}1. JellyJelly API Token ${RED}(required)${RESET}"
  echo -e "   ${DIM}Open JellyJelly in your browser → DevTools → Application → Cookies → copy 'token'${RESET}"
  read -rp "   JELLY_AUTH_TOKEN: " JELLY_TOKEN
  while [[ -z "$JELLY_TOKEN" ]]; do
    echo -e "   ${RED}This is required to poll the JellyJelly firehose.${RESET}"
    read -rp "   JELLY_AUTH_TOKEN: " JELLY_TOKEN
  done
  set_env "JELLY_AUTH_TOKEN" "$JELLY_TOKEN"
  ok "JellyJelly token saved"

  echo ""

  # ── Required: Telegram ──
  echo -e "${BOLD}2. Telegram Bot ${RED}(required)${RESET}"
  echo -e "   ${DIM}Open Telegram → message @BotFather → /newbot → copy the token${RESET}"
  read -rp "   TELEGRAM_BOT_TOKEN: " TG_TOKEN
  while [[ -z "$TG_TOKEN" ]]; do
    echo -e "   ${RED}Genie reports all results via Telegram. This is required.${RESET}"
    read -rp "   TELEGRAM_BOT_TOKEN: " TG_TOKEN
  done
  set_env "TELEGRAM_BOT_TOKEN" "$TG_TOKEN"
  ok "Telegram bot token saved"

  echo ""
  echo -e "   ${DIM}Your Telegram user ID. Message @userinfobot on Telegram — it replies with your ID.${RESET}"
  read -rp "   TELEGRAM_CHAT_ID: " TG_CHAT
  while [[ -z "$TG_CHAT" ]]; do
    echo -e "   ${RED}Required so JellyGenie knows where to send messages.${RESET}"
    read -rp "   TELEGRAM_CHAT_ID: " TG_CHAT
  done
  set_env "TELEGRAM_CHAT_ID" "$TG_CHAT"
  ok "Telegram chat ID saved"

  # Test Telegram
  echo ""
  info "Testing Telegram connection..."
  TG_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" -d text="🧞 JellyGenie is being set up on a new machine." 2>&1)
  if echo "$TG_RESULT" | grep -q '"ok":true'; then
    ok "Telegram connected — check your phone!"
  else
    warn "Telegram test failed. Check your token and chat ID."
    echo -e "   ${DIM}Response: $(echo "$TG_RESULT" | head -c 200)${RESET}"
    echo "   You can fix this later by editing .env"
  fi

  echo ""

  # ── Optional keys ──
  echo -e "${BOLD}3. Optional integrations ${DIM}(press Enter to skip any)${RESET}"
  echo ""

  echo -e "   ${DIM}OpenRouter API key — enables free-model fallback mode${RESET}"
  read -rp "   OPENROUTER_API_KEY [skip]: " OR_KEY
  [[ -n "$OR_KEY" ]] && set_env "OPENROUTER_API_KEY" "$OR_KEY" && ok "OpenRouter key saved"

  echo ""
  echo -e "   ${DIM}Stripe secret key — enables payment link wishes${RESET}"
  read -rp "   STRIPE_SECRET_KEY [skip]: " STRIPE_KEY
  [[ -n "$STRIPE_KEY" ]] && set_env "STRIPE_SECRET_KEY" "$STRIPE_KEY" && ok "Stripe key saved"

  echo ""
  echo -e "   ${DIM}Your GitHub username — used for Vercel deploys${RESET}"
  read -rp "   GH_OWNER [skip]: " GH_OWNER
  [[ -n "$GH_OWNER" ]] && set_env "GH_OWNER" "$GH_OWNER" && ok "GitHub owner saved"

  echo ""
  echo -e "   ${DIM}Your display name — used in outreach emails and messages${RESET}"
  read -rp "   JELLYGENIE_OWNER_NAME [skip]: " OWNER_NAME
  [[ -n "$OWNER_NAME" ]] && set_env "JELLYGENIE_OWNER_NAME" "$OWNER_NAME" && ok "Owner name saved"

  echo ""
  ok ".env configured"
fi

echo ""

# ── Step 5: Create directories ──────────────────────────────────────────────
mkdir -p "$GENIE_HOME/browser-profile"
ok "Browser profile dir: $GENIE_HOME/browser-profile"
mkdir -p "$LOG_DIR"
ok "Log directory: $LOG_DIR"

echo ""

# ── Step 6: Install LaunchAgents ─────────────────────────────────────────────
info "Installing LaunchAgents..."
mkdir -p "$LAUNCH_AGENTS"

NODE_PATH="$(which node)"

install_plist() {
  local src="$1" name="$2"
  local dest="$LAUNCH_AGENTS/$name"
  if [[ -f "$dest" ]]; then
    warn "$name already exists — updating"
    launchctl unload "$dest" 2>/dev/null || true
  fi
  sed -e "s|/Users/YOURNAME|$HOME|g" \
      -e "s|NODE_BIN|$NODE_PATH|g" \
      -e "s|GENIE_REPO_DIR|$REPO_DIR|g" \
      "$src" > "$dest"
  ok "Installed $dest"
}

install_plist "$REPO_DIR/examples/com.jellygenie.chrome.plist" "com.jellygenie.chrome.plist"
install_plist "$REPO_DIR/examples/com.jellygenie.server.plist" "com.jellygenie.server.plist"

echo ""

# ── Step 7: Install skills ──────────────────────────────────────────────────
info "Installing skills..."
mkdir -p "$SKILLS_SRC"

for skill_dir in "$REPO_DIR"/skills/ubereats-*/; do
  [[ -d "$skill_dir" ]] || continue
  skill_name="$(basename "$skill_dir")"
  dest="$SKILLS_SRC/$skill_name"
  if [[ -d "$dest" ]]; then
    warn "$skill_name already exists — skipping"
  else
    cp -r "$skill_dir" "$dest"
    ok "Installed skill: $skill_name"
  fi
done

if ! ls "$REPO_DIR"/skills/ubereats-*/ &>/dev/null 2>&1; then
  warn "No skills found in repo. Skills are optional."
fi

echo ""

# ── Step 8: Claude Code project settings ─────────────────────────────────────
info "Setting up Claude Code project settings..."
mkdir -p "$REPO_DIR/.claude"
SETTINGS_FILE="$REPO_DIR/.claude/settings.json"
if [[ -f "$SETTINGS_FILE" ]]; then
  ok ".claude/settings.json already exists"
else
  cat > "$SETTINGS_FILE" << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "Task",
      "TodoWrite",
      "WebSearch",
      "WebFetch(*)",
      "Skill(*)",
      "mcp__playwright__*"
    ],
    "deny": [],
    "defaultMode": "bypassPermissions"
  }
}
SETTINGS
  ok "Created .claude/settings.json"
fi

echo ""

# ── Step 9: Test Claude Code auth ────────────────────────────────────────────
info "Testing Claude Code authentication..."
if timeout 30 claude -p "echo ok" --output-format text &>/dev/null; then
  ok "Claude Code authenticated"
else
  warn "Claude Code auth failed. Fix with one of:"
  echo "    1. Run 'claude' interactively to complete OAuth login"
  echo "    2. Set ANTHROPIC_API_KEY in your shell profile"
  echo "  Setup will continue — fix auth before first wish."
fi

echo ""

# ── Step 10: Start Chrome + browser login ────────────────────────────────────
info "Starting Chrome with CDP (remote debugging)..."

launchctl unload "$LAUNCH_AGENTS/com.jellygenie.chrome.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENTS/com.jellygenie.chrome.plist" 2>/dev/null

sleep 3

CDP_OK=false
if curl -s --max-time 5 "http://127.0.0.1:9222/json/version" &>/dev/null; then
  CDP_OK=true
  ok "Chrome CDP endpoint live at http://127.0.0.1:9222"
else
  info "Waiting for Chrome cold start..."
  sleep 5
  if curl -s --max-time 5 "http://127.0.0.1:9222/json/version" &>/dev/null; then
    CDP_OK=true
    ok "Chrome CDP endpoint live at http://127.0.0.1:9222"
  else
    warn "Chrome CDP not responding. You may need to start Chrome manually."
  fi
fi

if $CDP_OK; then
  echo ""
  echo -e "${BOLD}🌐 A Chrome window has opened — that's the JellyGenie browser.${RESET}"
  echo ""
  echo "   Log into each site you want JellyGenie to use."
  echo -e "   ${DIM}Check 'Keep me signed in' on every login. Skip any you don't use.${RESET}"
  echo ""
  echo "    1. Twitter/X          5. Vercel            9. Airbnb"
  echo "    2. LinkedIn            6. GitHub           10. Calendly"
  echo "    3. Gmail               7. Stripe           11. Venmo"
  echo "    4. Uber Eats           8. OpenTable        12. Notion"
  echo ""

  # Open login pages in background
  for url in \
    "https://x.com/i/flow/login" \
    "https://www.linkedin.com/login" \
    "https://accounts.google.com" \
    "https://www.ubereats.com" \
    "https://vercel.com/login" \
    "https://github.com/login" \
    "https://dashboard.stripe.com/login" \
    "https://www.opentable.com/sign-in" \
    "https://www.airbnb.com/login" \
    "https://calendly.com/login" \
    "https://account.venmo.com/sign-in" \
    "https://www.notion.so/login"; do
    curl -s -X PUT "http://127.0.0.1:9222/json/new?$url" > /dev/null 2>&1 &
  done
  wait

  read -rp "Press Enter once you've logged in to continue..."
fi

echo ""

# ── Step 11: Start JellyGenie server ─────────────────────────────────────────
info "Starting JellyGenie server..."
launchctl unload "$LAUNCH_AGENTS/com.jellygenie.server.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENTS/com.jellygenie.server.plist" 2>/dev/null

sleep 3

if launchctl list 2>/dev/null | grep -q "com.jellygenie.server"; then
  ok "JellyGenie server running"
  if [[ -f "$LOG_DIR/launchd.out.log" ]]; then
    LAST_LINE=$(tail -1 "$LOG_DIR/launchd.out.log" 2>/dev/null || true)
    if echo "$LAST_LINE" | grep -q "Polling\|POLL"; then
      ok "Server is polling JellyJelly"
    fi
  fi
else
  warn "Server may not have started. Check: launchctl list | grep jellygenie"
fi

echo ""

# ── Step 12: Success banner ──────────────────────────────────────────────────
echo -e "${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  🧞 JellyGenie is running!${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Record a JellyJelly video and say 'genie' to trigger a wish."
echo ""
echo -e "  ${CYAN}Logs:${RESET}"
echo "    tail -f $LOG_DIR/launchd.out.log"
echo ""
echo -e "  ${CYAN}Stop:${RESET}"
echo "    launchctl unload ~/Library/LaunchAgents/com.jellygenie.server.plist"
echo "    launchctl unload ~/Library/LaunchAgents/com.jellygenie.chrome.plist"
echo ""
echo -e "  ${CYAN}Restart:${RESET}"
echo "    launchctl unload ~/Library/LaunchAgents/com.jellygenie.server.plist"
echo "    launchctl load -w ~/Library/LaunchAgents/com.jellygenie.server.plist"
echo ""
echo -e "  ${CYAN}Develop:${RESET}"
echo "    cd $(basename "$REPO_DIR") && claude"
echo ""
