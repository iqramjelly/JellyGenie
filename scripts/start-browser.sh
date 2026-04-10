#!/usr/bin/env bash
# Genie persistent Chrome helper.
#
# Usage:
#   scripts/start-browser.sh load      # install + start launchd agent
#   scripts/start-browser.sh unload    # stop launchd agent
#   scripts/start-browser.sh restart   # unload + load
#   scripts/start-browser.sh status    # launchctl list + CDP probe
#   scripts/start-browser.sh logs      # tail chrome logs
set -euo pipefail

PLIST_SRC="$HOME/Library/LaunchAgents/com.jellygenie.chrome.plist"
LABEL="com.jellygenie.chrome"
PROFILE="$HOME/.jellygenie/browser-profile"
CDP_URL="http://127.0.0.1:9222/json/version"

ensure_dirs() {
  mkdir -p /tmp/jellygenie-logs
  mkdir -p "$PROFILE"
}

kill_conflicting_chrome() {
  # Only kill Chrome processes that use OUR profile dir. Never touch the user's main Chrome.
  local pids
  pids=$(pgrep -f "user-data-dir=$PROFILE" || true)
  if [[ -n "${pids:-}" ]]; then
    echo "killing conflicting Chrome on profile $PROFILE: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(pgrep -f "user-data-dir=$PROFILE" || true)
    [[ -n "${pids:-}" ]] && kill -9 $pids 2>/dev/null || true
  fi
  # Also kill stray CDP Chrome on .genie-chrome-cdp (old path from prior runs)
  local stray
  stray=$(pgrep -f "user-data-dir=$HOME/.genie-chrome-cdp" || true)
  if [[ -n "${stray:-}" ]]; then
    echo "killing legacy CDP Chrome on .genie-chrome-cdp: $stray"
    kill $stray 2>/dev/null || true
    sleep 1
    stray=$(pgrep -f "user-data-dir=$HOME/.genie-chrome-cdp" || true)
    [[ -n "${stray:-}" ]] && kill -9 $stray 2>/dev/null || true
  fi
}

cmd_load() {
  ensure_dirs
  kill_conflicting_chrome
  launchctl unload -w "$PLIST_SRC" 2>/dev/null || true
  launchctl load  -w "$PLIST_SRC"
  sleep 2
  cmd_status
}

cmd_unload() {
  launchctl unload -w "$PLIST_SRC" 2>/dev/null || true
  echo "unloaded $LABEL"
}

cmd_restart() {
  cmd_unload
  kill_conflicting_chrome
  cmd_load
}

cmd_status() {
  echo "=== launchctl ==="
  launchctl list | grep "$LABEL" || echo "(not loaded)"
  echo "=== CDP probe ==="
  curl -s --max-time 3 "$CDP_URL" || echo "(no response on 9222)"
  echo
}

cmd_logs() {
  tail -n 80 -f /tmp/jellygenie-logs/chrome.out.log /tmp/jellygenie-logs/chrome.err.log
}

case "${1:-status}" in
  load)    cmd_load ;;
  unload)  cmd_unload ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *) echo "usage: $0 {load|unload|restart|status|logs}"; exit 1 ;;
esac
