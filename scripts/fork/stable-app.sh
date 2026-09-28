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
# changes when you run `build` + `install` here.
set -euo pipefail

# Homebrew's rustup is keg-only; the desktop build needs its cargo.
for rust_bin in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
  [ -d "$rust_bin" ] && PATH="$rust_bin:$PATH"
done
export PATH

STABLE_DIR="${T3_STABLE_DIR:-$HOME/Code/projects/t3-code-stable}"
APP_NAME="T3 Code (Alpha).app"
APP_PATH="/Applications/$APP_NAME"
DATA_DIR="$HOME/.t3/userdata"
PROFILE_DIR="$HOME/Library/Application Support/t3code"
BACKUP_ROOT="$HOME/.t3/backups"
PREVIOUS_APP_DIR="$BACKUP_ROOT/previous-app"
INSTALLED_STAMP="$BACKUP_ROOT/INSTALLED"
KEEP_BACKUPS=10

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

  build [ref]   Build the app from a git ref (default: main) in $STABLE_DIR
  install       Back up chats + folders, then install the last build (quit T3 Code first)
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
  backup) cmd_backup ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) usage; exit 1 ;;
esac
