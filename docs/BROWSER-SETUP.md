# Genie Persistent Browser Setup

Genie drives your **real Chrome** via the Chrome DevTools Protocol (CDP) on
`127.0.0.1:9222`. Chrome is kept alive by a macOS LaunchAgent so that cookies,
OAuth sessions, 2FA trust, and logged-in tabs persist across reboots. A spawned
`claude -p` subprocess attaches to this Chrome through the `@playwright/mcp`
MCP server (stdio) using `--cdp-endpoint http://127.0.0.1:9222`.

- Profile dir: `~/.genie/browser-profile`
- LaunchAgent plist: `~/Library/LaunchAgents/com.genie.chrome.plist`
- MCP config: `config/mcp.json`
- Helper script: `scripts/start-browser.sh`
- Logs: `/tmp/genie-logs/chrome.out.log`, `/tmp/genie-logs/chrome.err.log`

This Chrome runs as a **separate instance** from your main daily Chrome — they
use different `--user-data-dir` values so they do not conflict. You can have
both open at the same time.

## One-time login flow

After the LaunchAgent Chrome is up, switch to that Chrome window (it will
appear as a normal Chrome app window) and log in to every service Genie needs:

1. `https://www.linkedin.com` — log in, complete any 2FA, check "remember me".
2. `https://mail.google.com` — log in to the Google account you want Genie to use.
3. `https://x.com` (formerly Twitter) — log in.
4. `https://vercel.com` — log in (SSO via GitHub/Google is fine).
5. Any other service you want Genie to touch (GitHub, Notion, Telegram Web, etc.).

Close the tabs when done — the cookies/localStorage are stored in the profile
dir and survive Chrome restarts forever (until you clear them or a site
invalidates the session).

> Tip: if you want specific tabs to auto-reopen every launch, leave them open
> and quit Chrome normally — `--restore-last-session` will bring them back.

## Verify the browser is alive

```bash
curl -s http://127.0.0.1:9222/json/version | jq .
# Should print Browser, Protocol-Version, webSocketDebuggerUrl...

# List all open tabs:
curl -s http://127.0.0.1:9222/json | jq '.[] | select(.type=="page") | {title, url}'

# LaunchAgent state:
launchctl list | grep com.genie.chrome
# -> <pid>  0  com.genie.chrome   (a numeric PID means it's running)
```

## Start / stop / restart

Use the helper script:

```bash
scripts/start-browser.sh load      # install + start (idempotent)
scripts/start-browser.sh status    # launchctl + CDP probe
scripts/start-browser.sh restart   # unload, kill any strays, reload
scripts/start-browser.sh unload    # stop
scripts/start-browser.sh logs      # tail stdout/stderr
```

Or the raw launchctl commands:

```bash
launchctl load   -w ~/Library/LaunchAgents/com.genie.chrome.plist
launchctl unload -w ~/Library/LaunchAgents/com.genie.chrome.plist
```

`KeepAlive.Crashed` is on — if Chrome crashes, launchd relaunches it after
`ThrottleInterval` (15s). `SuccessfulExit=false` means if you quit Chrome via
the menu, launchd will NOT relaunch it (expected; use `start-browser.sh load`).

## Smoke test the MCP path

```bash
claude -p "Open the current tab, take a snapshot, and print the page title and URL" \
  --mcp-config config/mcp.json \
  --allowedTools "mcp__playwright__*" \
  --permission-mode bypassPermissions \
  --output-format text
```

It should print the title + URL of whatever tab is currently focused, without
spawning a new Chrome window.

## Troubleshooting

### Port 9222 already taken

```bash
lsof -nP -iTCP:9222 -sTCP:LISTEN
```

If the PID belongs to a Chrome using `--user-data-dir=~/.genie/browser-profile`,
that's our own launchd instance — leave it alone. If it's a different process
(an old playwright run, a ChromeDriver, etc.), kill it:

```bash
kill <pid>                               # graceful
kill -9 <pid>                            # force
scripts/start-browser.sh restart         # bring ours back cleanly
```

### "Chrome refuses to start — another instance is using the profile"

Chrome's `SingletonLock` in the profile dir is sticky if Chrome crashed hard.
Fix:

```bash
scripts/start-browser.sh unload
rm -f ~/.genie/browser-profile/SingletonLock \
      ~/.genie/browser-profile/SingletonSocket \
      ~/.genie/browser-profile/SingletonCookie
scripts/start-browser.sh load
```

Do NOT delete the whole profile dir — that nukes all your logins.

### Legacy `~/.genie-chrome-cdp` profile

Earlier playwright test runs may have created a second profile at
`~/.genie-chrome-cdp`. The helper script's `kill_conflicting_chrome`
automatically shuts down any Chrome still bound to that path. If you want to
migrate old cookies from there into the canonical profile, quit both Chromes
first and then:

```bash
# one-shot migration, only if the canonical profile is empty/fresh
cp -R ~/.genie-chrome-cdp/Default ~/.genie/browser-profile/Default
```

### Cookies expired / "please log in again"

Some services (Google, LinkedIn) rotate long-term cookies. When that happens,
just re-open the site in the launchd Chrome window and log in again — the new
cookies are written straight back to `~/.genie/browser-profile`. No Genie
restart needed; the next `claude -p` invocation will pick them up.

### MCP cannot connect to CDP

```bash
curl -s http://127.0.0.1:9222/json/version
```

- No response → Chrome isn't running. `scripts/start-browser.sh status`, then
  `load` if not loaded, then check `/tmp/genie-logs/chrome.err.log`.
- Response but MCP still fails → make sure you're passing
  `--cdp-endpoint http://127.0.0.1:9222` (not `ws://...`). The MCP package
  fetches `/json/version` itself to discover the websocket URL.

### Main Chrome conflict

Your **daily-driver Chrome** (the one on the default profile) is untouched by
all of this — it lives under `~/Library/Application Support/Google/Chrome`,
not `~/.genie/browser-profile`, and does not use port 9222. You can run both
simultaneously. `start-browser.sh` only kills Chromes whose command line
contains `user-data-dir=~/.genie/browser-profile` or the legacy
`user-data-dir=~/.genie-chrome-cdp` — never the default profile.
