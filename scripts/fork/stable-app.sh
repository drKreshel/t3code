#!/usr/bin/env bash
# Build and install the stable (daily-driver) T3 Code app from this fork.
#
# Three instances live side by side:
#   stable  /Applications/T3 Code (Alpha).app  data ~/.t3/userdata   profile ~/Library/Application Support/t3code
#   dev     `vp run dev:desktop` in the dev checkout, data ~/.t3/dev, profile .../t3code-dev
#   build   a script-owned git worktree (T3_STABLE_DIR) that only this script touches
#
# The stable app keeps the upstream name and app id, so it takes over the old
# Alpha install and its data. Local builds carry no update feed: the app only
# changes when you run `build` + `install` (or `ship`) here.
set -euo pipefail

# Homebrew's rustup is keg-only; the desktop build needs its cargo.
for rust_bin in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
  [ -d "$rust_bin" ] && PATH="$rust_bin:$PATH"
done
export PATH

STABLE_DIR="${T3_STABLE_DIR:-$HOME/Code/projects/t3-code-stable}"
APP_NAME="T3 Code (Alpha).app"
APP_PATH="/Applications/$APP_NAME"
APP_ID="com.t3tools.t3code"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
DATA_DIR="$HOME/.t3/userdata"
PROFILE_DIR="$HOME/Library/Application Support/t3code"
BACKUP_ROOT="$HOME/.t3/backups"
PREVIOUS_APP_DIR="$BACKUP_ROOT/previous-app"
INSTALLED_STAMP="$BACKUP_ROOT/INSTALLED"
KEEP_BACKUPS=10
RESTART_LOG="$BACKUP_ROOT/restart.log"
# Seconds a detached restart waits before quitting, so a chat that started it
# can finish its reply.
RESTART_DELAY="${T3_STABLE_RESTART_DELAY:-15}"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

  build [ref]   Build the app from a git ref (default: main) in $STABLE_DIR
  install       Back up chats + folders, then install the last build (quit T3 Code first)
  restart       Quit T3 Code, install the last build, and reopen it (safe to run from a chat)
  ship [ref]    build, then restart
  backup        Back up chats (database) and folders/settings (app profile)
  rollback      Reinstall the app that was installed before the last install
  status        Show refs, the last build, and the installed app
EOF
}

stable_app_running() {
  # Detection only: never kill by pattern. Fixed-string match, since the
  # app name contains regex characters.
  ps -axo command= | grep -F "$APP_PATH/Contents/MacOS/" | grep -vqF "grep -F"
}

require_app_quit() {
  if stable_app_running; then
    die "T3 Code is running. Quit it (⌘Q), then run this again."
  fi
}

latest_zip() {
  ls -t "$STABLE_DIR"/release/*.zip 2>/dev/null | head -1 || true
}

cmd_build() {
  local ref="${1:-main}"
  [ -d "$STABLE_DIR/.git" ] || [ -f "$STABLE_DIR/.git" ] ||
    die "No build worktree at $STABLE_DIR. Create it with: git worktree add --detach $STABLE_DIR main"
  command -v cargo >/dev/null || die "Rust is required for the desktop build: brew install rustup && $(brew --prefix rustup 2>/dev/null)/bin/rustup default stable"
  local sha
  sha="$(git -C "$STABLE_DIR" rev-parse --verify "$ref^{commit}")" || die "Unknown ref: $ref"
  log "Checking out $ref ($(git -C "$STABLE_DIR" log --oneline -1 "$sha"))"
  # This worktree is script-owned: local edits here are discarded on purpose.
  git -C "$STABLE_DIR" checkout --quiet --force --detach "$sha"
  git -C "$STABLE_DIR" clean -fdq
  log "Installing dependencies"
  (cd "$STABLE_DIR" && pnpm install --frozen-lockfile)
  log "Building the desktop app (takes a few minutes)"
  rm -rf "$STABLE_DIR/release"
  (cd "$STABLE_DIR" && pnpm exec vp run dist:desktop:dmg)
  printf '%s %s\n' "$sha" "$ref" >"$STABLE_DIR/release/BUILT_FROM"
  log "Built: $(latest_zip)"
  log "Next: quit T3 Code (⌘Q), then run: $0 install"
}

cmd_backup() {
  local dir
  dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  if [ -f "$DATA_DIR/state.sqlite" ]; then
    # VACUUM INTO is a consistent snapshot even while a server has the file open.
    sqlite3 -readonly "$DATA_DIR/state.sqlite" "VACUUM INTO '$dir/state.sqlite'"
  fi
  for file in settings.json client-settings.json keybindings.json; do
    [ -f "$DATA_DIR/$file" ] && cp "$DATA_DIR/$file" "$dir/"
  done
  # Folders live in the app profile's localStorage; copy it only while the app is quit.
  if [ -d "$PROFILE_DIR/Local Storage" ] && ! stable_app_running; then
    cp -R "$PROFILE_DIR/Local Storage" "$dir/Local Storage"
  fi
  log "Backed up to $dir"
  # Keep the newest timestamped backups; named backups are left alone.
  ls -1d "$BACKUP_ROOT"/[0-9]*-[0-9]* 2>/dev/null | grep -E '/[0-9]{8}-[0-9]{6}$' |
    sort -r | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -rf "$old"; done
}

cmd_install() {
  local zip
  zip="$(latest_zip)"
  [ -n "$zip" ] || die "No build found. Run: $0 build"
  require_app_quit
  cmd_backup
  if [ -d "$APP_PATH" ]; then
    log "Keeping the current app for rollback"
    rm -rf "$PREVIOUS_APP_DIR"
    mkdir -p "$PREVIOUS_APP_DIR"
    mv "$APP_PATH" "$PREVIOUS_APP_DIR/"
  fi
  log "Installing $(basename "$zip")"
  ditto -x -k "$zip" /Applications/
  [ -d "$APP_PATH" ] || die "The build did not contain $APP_NAME"
  xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
  {
    printf 'installed %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    cat "$STABLE_DIR/release/BUILT_FROM" 2>/dev/null || true
  } >"$INSTALLED_STAMP"
  log "Installed. Open T3 Code as usual."
}

notify() {
  osascript -e "display notification \"$1\" with title \"T3 Code\"" >/dev/null 2>&1 || true
}

# Runs this script again in its own session, reparented to launchd, so it
# survives T3 Code quitting (and taking the chat that called it down with it).
detach_restart() {
  mkdir -p "$BACKUP_ROOT"
  T3_STABLE_DETACHED=1 python3 - "$SCRIPT_PATH" "$RESTART_LOG" <<'PY'
import os, sys
if os.fork():
    sys.exit(0)
os.setsid()
if os.fork():
    sys.exit(0)
log = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.dup2(log, 1)
os.dup2(log, 2)
os.execvp("bash", ["bash", sys.argv[1], "restart"])
PY
}

cmd_restart() {
  [ -n "$(latest_zip)" ] || die "No build found. Run: $0 build"
  if [ "${T3_STABLE_DETACHED:-}" != 1 ]; then
    detach_restart
    log "In ${RESTART_DELAY}s T3 Code quits, installs $(basename "$(latest_zip)"), and reopens."
    log "Progress: $RESTART_LOG"
    return
  fi
  echo "---- restart $(date '+%Y-%m-%d %H:%M:%S')"
  # Leave a trace if anything below ends the script early.
  trap 'echo "restart exited with status $? (last command: $BASH_COMMAND) at $(date +%T)"' EXIT
  sleep "$RESTART_DELAY"
  if stable_app_running; then
    log "Quitting T3 Code"
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    local waited=0
    while stable_app_running && [ "$waited" -lt 90 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if stable_app_running; then
      notify "Update cancelled: T3 Code did not quit."
      die "T3 Code did not quit within 90s; nothing was installed."
    fi
  fi
  local result="Updated and reopened."
  if ! (cmd_install); then
    result="Update failed; the previous app was kept. See $RESTART_LOG"
    # Install moves the old app aside before unpacking; put it back if needed.
    if [ ! -d "$APP_PATH" ] && [ -d "$PREVIOUS_APP_DIR/$APP_NAME" ]; then
      mv "$PREVIOUS_APP_DIR/$APP_NAME" /Applications/
    fi
  fi
  # Reopen before notifying: getting the app back is the part that matters.
  reopen_app || result="Installed, but T3 Code did not reopen. Open it from Applications."
  log "$result"
  notify "$result"
}

reopen_app() {
  [ -d "$APP_PATH" ] || return 1
  # A freshly unpacked bundle may not be registered with Launch Services yet.
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
  local attempt
  for attempt in 1 2 3; do
    log "Reopening T3 Code (attempt $attempt)"
    open "$APP_PATH" || log "open exited with status $?"
    sleep 5
    if stable_app_running; then
      log "T3 Code is running"
      return 0
    fi
  done
  return 1
}

cmd_ship() {
  cmd_build "$@"
  cmd_restart
}

cmd_rollback() {
  local previous="$PREVIOUS_APP_DIR/$APP_NAME"
  [ -d "$previous" ] || die "No previous app to roll back to."
  require_app_quit
  local swap="$BACKUP_ROOT/rollback-swap"
  rm -rf "$swap" && mkdir -p "$swap"
  [ -d "$APP_PATH" ] && mv "$APP_PATH" "$swap/"
  mv "$previous" /Applications/
  rm -rf "$PREVIOUS_APP_DIR" && mv "$swap" "$PREVIOUS_APP_DIR"
  log "Rolled back. Run rollback again to switch back."
}

cmd_status() {
  local repo
  repo="$(git -C "$STABLE_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  echo "build worktree:  $STABLE_DIR"
  [ -n "$repo" ] && {
    echo "  main:          $(git -C "$STABLE_DIR" log --oneline -1 main 2>/dev/null)"
    echo "  upstream/main: $(git -C "$STABLE_DIR" log --oneline -1 upstream/main 2>/dev/null)"
    echo "  checked out:   $(git -C "$STABLE_DIR" log --oneline -1 HEAD)"
  }
  echo "last build:      $(latest_zip || true) $(cat "$STABLE_DIR/release/BUILT_FROM" 2>/dev/null || true)"
  if [ -d "$APP_PATH" ]; then
    echo "installed app:   $APP_PATH $(defaults read "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
  else
    echo "installed app:   none"
  fi
  [ -f "$INSTALLED_STAMP" ] && sed 's/^/                 /' "$INSTALLED_STAMP"
  stable_app_running && echo "running:         yes" || echo "running:         no"
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  install) cmd_install ;;
  restart) cmd_restart ;;
  ship) shift; cmd_ship "$@" ;;
  backup) cmd_backup ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) usage; exit 1 ;;
esac
