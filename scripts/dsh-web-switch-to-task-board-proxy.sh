#!/usr/bin/env bash
#
# One-shot cutover from the raw socat public forward to the authenticating
# task-board proxy (scripts/dsh-web-task-board-proxy.mjs).
#
# Why a dedicated script: the switch restarts the Harness, which is the process
# serving the very session that asked for it. This script therefore
#   * waits for the in-flight turn to actually finish — the session event log
#     records `turn/end`, and the last turn boundary is `turn/end` only while
#     no turn runs (scripts/dsh-session-turn-state.mjs), so a slow model step
#     can never be mistaken for an idle moment;
#   * detaches from the Harness process tree (launch it with setsid, see
#     below), so stopping the Harness cannot stop the cutover;
#   * verifies the new setup and rolls back to the previous socat forward if
#     verification fails.
#
# Usage:
#   ( setsid nohup scripts/dsh-web-switch-to-task-board-proxy.sh >/dev/null 2>&1 & )
#   # or, interactively:
#   scripts/dsh-web-switch-to-task-board-proxy.sh
#
# Environment overrides:
#   DSH_NODE                     Node binary for the turn-state helper
#   DSH_SWITCH_MAX_WAIT_SECONDS  give up waiting for the turn end (default: 900)
#   DSH_SWITCH_GRACE_SECONDS     pause after the turn ends, so the answer can be
#                                read before the page drops (default: 60)
#   DSH_RUNTIME_DIR              runtime directory (default: /tmp/deepseek-harness-web)
#
# Every step is appended to \$DSH_RUNTIME_DIR/switch.log.

set -Eeuo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUNTIME_DIR="${DSH_RUNTIME_DIR:-/tmp/deepseek-harness-web}"
readonly LOG_FILE="$RUNTIME_DIR/switch.log"
readonly BACKEND="$ROOT_DIR/scripts/dsh-web-background.sh"
readonly DSH_NODE="${DSH_NODE:-/opt/node-v22.22.1-linux-x64/bin/node}"
readonly TURN_STATE_SCRIPT="$ROOT_DIR/scripts/dsh-session-turn-state.mjs"
readonly MAX_WAIT_SECONDS="${DSH_SWITCH_MAX_WAIT_SECONDS:-900}"
readonly GRACE_SECONDS="${DSH_SWITCH_GRACE_SECONDS:-60}"

mkdir -p "$RUNTIME_DIR"
exec >> "$LOG_FILE" 2>&1

say() {
  printf '%s [switch] %s\n' "$(date -Is)" "$*"
}

turn_state() {
  "$DSH_NODE" "$TURN_STATE_SCRIPT" "$1" 2>/dev/null || true
}

json_number() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p"
}

json_word() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# Wait until the current turn is over. The session log appends a turn/end
# record when a turn settles; while a turn runs, the last turn boundary is its
# turn/start, so this cannot fire mid-answer even across a long model step.
wait_for_turn_end() {
  local home="${DSH_HOME:-$HOME/.dsh}" session_id="${DSH_SESSION_ID:-}" file deadline state baseline max last
  if [[ -n "$session_id" ]]; then
    file="$(find "$home/sessions" -path "*${session_id}*" -name 'session.v4.jsonl.zstd' 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "${file:-}" || ! -f "$file" ]]; then
    say "no session log for '${session_id:-<unset>}'; falling back to a 120s delay"
    sleep 120
    return 0
  fi

  baseline="$(json_number "$(turn_state "$file")" maxTurnEnd)"
  baseline="${baseline:-0}"
  say "waiting for turn $((baseline + 1)) to end (log: $file)"
  deadline=$((SECONDS + MAX_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    state="$(turn_state "$file")"
    max="$(json_number "$state" maxTurnEnd)"
    last="$(json_word "$state" lastBoundary)"
    if [[ -n "$max" && "$max" -gt "$baseline" && "$last" == "turn/end" ]]; then
      say "turn $max finished; switching in ${GRACE_SECONDS}s unless a new turn starts"
      sleep "$GRACE_SECONDS"
      state="$(turn_state "$file")"
      if [[ "$(json_word "$state" lastBoundary)" == "turn/end" ]]; then
        return 0
      fi
      say "a new turn started; waiting for it to finish"
    fi
    sleep 5
  done
  say "ABORT: no turn end within ${MAX_WAIT_SECONDS}s; nothing changed"
  exit 0
}

wait_for_turn_end

say "stopping the current Harness and public forward"
"$BACKEND" stop || true

say "starting the task-board proxy entry"
if ! DSH_PROXY_MODE=task-board "$BACKEND" start; then
  say "start failed; rolling back to the socat forward"
  "$BACKEND" stop || true
  DSH_PROXY_MODE=socat "$BACKEND" start || true
  say "ROLLED BACK: the GUI is served again by socat; the task board will answer 403"
  exit 1
fi

say "verifying the new entry"
if DSH_PROXY_MODE=task-board "$BACKEND" verify; then
  say "DONE: task-board proxy is live at ${DSH_PUBLIC_URL:-<public url>}"
  exit 0
fi

say "verification failed; rolling back to the socat forward"
"$BACKEND" stop || true
if DSH_PROXY_MODE=socat "$BACKEND" start; then
  say "ROLLED BACK: the GUI is served again by socat; the task board will answer 403"
else
  say "ROLLBACK FAILED: start the service manually with $BACKEND start"
fi
exit 1
