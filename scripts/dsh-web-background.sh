#!/usr/bin/env bash
#
# Start the Web profile and its public entry together, detached from the
# invoking terminal. The Harness listener stays on loopback. The public entry
# is one of:
#
#   task-board (default)
#     scripts/dsh-web-task-board-proxy.mjs, an authenticating reverse proxy
#     that injects the server-side token the task-board Host fence requires
#     (`trustedProxyHosts` + `x-dsh-task-board-proxy-token`). Host, Origin,
#     Cookie and Sec-Fetch-* reach the listener unchanged, so the harness's
#     own /api fence and browser-auth cookie keep working.
#
#   socat
#     a raw TCP forward that rewrites nothing. The GUI works, but every
#     /api/task-board/* request from a non-loopback authority is refused 403
#     by the plugin's fence (the panel shows board.hostError.forbidden).
#
# Usage:
#   scripts/dsh-web-background.sh start
#   scripts/dsh-web-background.sh status
#   scripts/dsh-web-background.sh restart
#   scripts/dsh-web-background.sh stop
#   scripts/dsh-web-background.sh verify
#   scripts/dsh-web-background.sh logs
#
# Environment overrides:
#   DSH_NODE                  Official Node binary with TypeScript support
#   PUBLIC_HOST               Browser-facing hostname or IPv4 address
#   DSH_INTERNAL_PORT         Harness loopback port (default: 9910)
#   DSH_PROXY_PORT            Public entry port (default: 8211)
#   DSH_PROXY_MODE            task-board | socat (default: task-board)
#   DSH_PROXY_BASIC_AUTH      user:pass, or off to disable proxy authentication
#   DSH_RUNTIME_DIR           PID, log, overlay and secret directory
#   DSH_WEB_READY_TIMEOUT_SECONDS  readiness budget (default: 30)

set -Eeuo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DSH_NODE="${DSH_NODE:-/opt/node-v22.22.1-linux-x64/bin/node}"
readonly INTERNAL_HOST="127.0.0.1"
readonly INTERNAL_PORT="${DSH_INTERNAL_PORT:-9910}"
readonly PROXY_BIND="${DSH_PROXY_BIND:-0.0.0.0}"
readonly PROXY_PORT="${DSH_PROXY_PORT:-8211}"
readonly PROXY_MODE="${DSH_PROXY_MODE:-task-board}"
readonly RUNTIME_DIR="${DSH_RUNTIME_DIR:-/tmp/deepseek-harness-web}"
readonly DSH_PID_FILE="$RUNTIME_DIR/harness.pid"
readonly DSH_LOG_FILE="$RUNTIME_DIR/harness.log"
readonly PROXY_PID_FILE="$RUNTIME_DIR/proxy.pid"
readonly PROXY_LOG_FILE="$RUNTIME_DIR/proxy.log"
readonly OVERLAY_FILE="$RUNTIME_DIR/no-hmr.overlay.yml"
readonly TASK_BOARD_TOKEN_FILE="$RUNTIME_DIR/task-board-proxy-token"
readonly BASIC_AUTH_FILE="$RUNTIME_DIR/proxy-basic-auth"
readonly PROXY_SCRIPT="$ROOT_DIR/scripts/dsh-web-task-board-proxy.mjs"
readonly READY_TIMEOUT="${DSH_WEB_READY_TIMEOUT_SECONDS:-30}"

die() {
  printf 'dsh-web-background: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'dsh-web-background: %s\n' "$*"
}

detect_public_host() {
  local address
  for address in $(hostname -I 2>/dev/null || true); do
    if [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s\n' "$address"
      return 0
    fi
  done
  printf '127.0.0.1\n'
}

readonly PUBLIC_HOST="${PUBLIC_HOST:-$(detect_public_host)}"
readonly PUBLIC_URL="${DSH_PUBLIC_URL:-http://${PUBLIC_HOST}:${PROXY_PORT}/}"
# Origin form of the same root: browsers send no trailing slash.
readonly PUBLIC_ORIGIN="${PUBLIC_URL%/}"
readonly PUBLIC_AUTHORITY="$(printf '%s' "${PUBLIC_ORIGIN#*://}")"

readonly DSH_PNPM="${DSH_PNPM:-$(command -v pnpm || true)}"
readonly SOCAT_BIN="${SOCAT_BIN:-$(command -v socat || true)}"
readonly START_STOP_DAEMON="${START_STOP_DAEMON:-$(command -v start-stop-daemon || true)}"
readonly PGREP_BIN="${PGREP_BIN:-$(command -v pgrep || true)}"
readonly CURL_BIN="${CURL_BIN:-$(command -v curl || true)}"
readonly OPENSSL_BIN="${OPENSSL_BIN:-$(command -v openssl || true)}"
readonly NATIVE_ADDON="${DSH_NATIVE_ADDON:-$ROOT_DIR/native/system/packages/linux-x64/bin/glibc/system.node}"
readonly NODE_BIN_DIR="$(dirname -- "$DSH_NODE")"

assert_prerequisites() {
  [[ -x "$DSH_NODE" ]] || die "Node binary is missing or not executable: $DSH_NODE"
  [[ -n "$DSH_PNPM" && -x "$DSH_PNPM" ]] || die "pnpm was not found"
  [[ -n "$START_STOP_DAEMON" && -x "$START_STOP_DAEMON" ]] || die "start-stop-daemon was not found"
  [[ -n "$PGREP_BIN" && -x "$PGREP_BIN" ]] || die "pgrep was not found"
  [[ -n "$OPENSSL_BIN" && -x "$OPENSSL_BIN" ]] || die "openssl was not found"
  [[ -d "$ROOT_DIR/node_modules" ]] || die "dependencies are missing; run pnpm install first"
  [[ -f "$ROOT_DIR/apps/web/dist/index.html" ]] || die "Web assets are missing; run pnpm run build:web first"
  [[ -f "$NATIVE_ADDON" ]] || die "native addon is missing; run pnpm run build:native-system first"

  case "$PROXY_MODE" in
    task-board)
      [[ -f "$PROXY_SCRIPT" ]] || die "proxy script is missing: $PROXY_SCRIPT"
      ;;
    socat)
      [[ -n "$SOCAT_BIN" && -x "$SOCAT_BIN" ]] || die "socat was not found"
      ;;
    *)
      die "DSH_PROXY_MODE must be task-board or socat (got: $PROXY_MODE)"
      ;;
  esac

  local typescript_feature
  typescript_feature="$("$DSH_NODE" -p 'process.features.typescript' 2>/dev/null || true)"
  [[ "$typescript_feature" != "false" && -n "$typescript_feature" ]] \
    || die "Node at $DSH_NODE lacks TypeScript stripping; use an official Node 22.19+ or 24+ build"
}

trusted_hosts() {
  local host
  {
    printf '%s\n' "$PUBLIC_HOST"
    hostname 2>/dev/null || true
    hostname -I 2>/dev/null | tr ' ' '\n' || true
  } | awk 'NF && !seen[$0]++'
}

# Canonical host:port authorities the browser can reach the entry through;
# these are the task-board fence's `trustedProxyHosts` allowlist.
proxy_authorities() {
  local host
  trusted_hosts | while IFS= read -r host; do
    printf '%s:%s\n' "$host" "$PROXY_PORT"
  done | awk 'NF && !seen[$0]++'
}

ensure_secret_file() {
  local file="$1" bytes="$2"
  if [[ -s "$file" ]]; then
    return 0
  fi
  ( umask 077; "$OPENSSL_BIN" rand -hex "$bytes" > "$file" )
  chmod 600 "$file"
  log "generated $file"
}

ensure_basic_auth_file() {
  if [[ "$(printf '%s' "${DSH_PROXY_BASIC_AUTH:-}")" == "off" ]]; then
    return 0
  fi
  if [[ -s "$BASIC_AUTH_FILE" ]]; then
    return 0
  fi
  local password
  password="$("$OPENSSL_BIN" rand -hex 12)"
  ( umask 077; printf 'dsh:%s\n' "$password" > "$BASIC_AUTH_FILE" )
  chmod 600 "$BASIC_AUTH_FILE"
  log "generated $BASIC_AUTH_FILE (user dsh)"
}

prepare_runtime() {
  mkdir -p "$RUNTIME_DIR"
  {
    printf '%s\n' '- id: hmr' '  disabled: true'
    if [[ "$PROXY_MODE" == "task-board" ]]; then
      printf '%s\n' \
        '- id: web-ui-task-board' \
        "  name: '@linxin666/dsh-client-ui-task-board'" \
        '  config:' \
        '    trustedProxyHosts:'
      local authority
      while IFS= read -r authority; do
        printf '      - "%s"\n' "$authority"
      done < <(proxy_authorities)
    fi
  } > "$OVERLAY_FILE"

  if [[ "$PROXY_MODE" == "task-board" ]]; then
    ensure_secret_file "$TASK_BOARD_TOKEN_FILE" 32
    ensure_basic_auth_file
  fi
}

pid_is_running() {
  local pid_file="$1" pid
  [[ -r "$pid_file" ]] || return 1
  read -r pid < "$pid_file" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

tcp_reachable() {
  local host="$1" port="$2"
  (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null
}

wait_for_tcp() {
  local host="$1" port="$2" deadline=$((SECONDS + READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if tcp_reachable "$host" "$port"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

startup_url() {
  grep -E '^dsh web: ' "$DSH_LOG_FILE" | tail -n 1 | sed 's/^dsh web: //' || true
}

wait_for_startup_url() {
  local deadline=$((SECONDS + READY_TIMEOUT)) url
  while (( SECONDS < deadline )); do
    url="$(startup_url)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

descendant_pids() {
  local parent="$1" child
  for child in $("$PGREP_BIN" -P "$parent" 2>/dev/null || true); do
    descendant_pids "$child"
  done
  printf '%s\n' "$parent"
}

stop_managed_process() {
  local label="$1" pid_file="$2" root pid pids
  if [[ ! -f "$pid_file" ]]; then
    log "$label is not running (no PID file)"
    return 0
  fi

  read -r root < "$pid_file" || true
  if [[ ! "$root" =~ ^[0-9]+$ ]] || ! kill -0 "$root" 2>/dev/null; then
    rm -f "$pid_file"
    log "$label is not running (removed stale PID file)"
    return 0
  fi

  mapfile -t pids < <(descendant_pids "$root")
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  local attempt
  for attempt in {1..50}; do
    kill -0 "$root" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$root" 2>/dev/null; then
    for pid in "${pids[@]}"; do
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi

  rm -f "$pid_file"
  log "stopped $label"
}

# Kill every unmanaged listener still holding the public port: stale socat
# forwards from earlier runs must not shadow the proxy.
kill_port_listeners() {
  local pid cmd
  for pid in $("$PGREP_BIN" -f "TCP-LISTEN:${PROXY_PORT}" 2>/dev/null || true); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 0.3
  for pid in $("$PGREP_BIN" -f "TCP-LISTEN:${PROXY_PORT}" 2>/dev/null || true); do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

start_harness() {
  if pid_is_running "$DSH_PID_FILE"; then
    log "Harness is already running (PID $(<"$DSH_PID_FILE"))"
    return 0
  fi
  if tcp_reachable "$INTERNAL_HOST" "$INTERNAL_PORT"; then
    die "$INTERNAL_HOST:$INTERNAL_PORT is already in use by an unmanaged process"
  fi

  : > "$DSH_LOG_FILE"
  local -a command=(dsh web --patch "$OVERLAY_FILE" --no-open --port "$INTERNAL_PORT" --public-url "$PUBLIC_URL")
  local host
  while IFS= read -r host; do
    command+=(--trusted-host "$host")
  done < <(trusted_hosts)

  if [[ "$PROXY_MODE" == "task-board" ]]; then
    export DSH_TASK_BOARD_PROXY_TOKEN
    DSH_TASK_BOARD_PROXY_TOKEN="$(<"$TASK_BOARD_TOKEN_FILE")"
  fi

  PATH="$NODE_BIN_DIR:$PATH" "$START_STOP_DAEMON" \
    --start --background --make-pidfile \
    --pidfile "$DSH_PID_FILE" \
    --output "$DSH_LOG_FILE" \
    --chdir "$ROOT_DIR" \
    --startas "$DSH_PNPM" \
    -- "${command[@]}"

  if ! wait_for_tcp "$INTERNAL_HOST" "$INTERNAL_PORT"; then
    tail -n 80 "$DSH_LOG_FILE" >&2 || true
    stop_managed_process "Harness" "$DSH_PID_FILE"
    die "Harness did not become ready on $INTERNAL_HOST:$INTERNAL_PORT"
  fi
  log "Harness started (PID $(<"$DSH_PID_FILE")) on $INTERNAL_HOST:$INTERNAL_PORT (proxy mode: $PROXY_MODE)"
}

start_proxy() {
  if pid_is_running "$PROXY_PID_FILE"; then
    log "proxy is already running (PID $(<"$PROXY_PID_FILE"))"
    return 0
  fi
  if tcp_reachable "$INTERNAL_HOST" "$PROXY_PORT"; then
    die "$PROXY_BIND:$PROXY_PORT is already in use by an unmanaged process"
  fi

  : > "$PROXY_LOG_FILE"
  if [[ "$PROXY_MODE" == "socat" ]]; then
    "$START_STOP_DAEMON" \
      --start --background --make-pidfile \
      --pidfile "$PROXY_PID_FILE" \
      --output "$PROXY_LOG_FILE" \
      --startas "$SOCAT_BIN" \
      -- "TCP-LISTEN:${PROXY_PORT},bind=${PROXY_BIND},reuseaddr,fork" \
      "TCP:${INTERNAL_HOST}:${INTERNAL_PORT}"
  else
    local -a proxy_env=(
      "DSH_PROXY_LISTEN_HOST=$PROXY_BIND"
      "DSH_PROXY_LISTEN_PORT=$PROXY_PORT"
      "DSH_PROXY_UPSTREAM_HOST=$INTERNAL_HOST"
      "DSH_PROXY_UPSTREAM_PORT=$INTERNAL_PORT"
      "DSH_TASK_BOARD_PROXY_TOKEN_FILE=$TASK_BOARD_TOKEN_FILE"
    )
    if [[ "$(printf '%s' "${DSH_PROXY_BASIC_AUTH:-}")" == "off" ]]; then
      proxy_env+=("DSH_PROXY_BASIC_AUTH=off")
    else
      proxy_env+=("DSH_PROXY_BASIC_AUTH_FILE=$BASIC_AUTH_FILE")
    fi
    env "${proxy_env[@]}" "$START_STOP_DAEMON" \
      --start --background --make-pidfile \
      --pidfile "$PROXY_PID_FILE" \
      --output "$PROXY_LOG_FILE" \
      --startas "$DSH_NODE" \
      -- "$PROXY_SCRIPT"
  fi

  if ! wait_for_tcp "$INTERNAL_HOST" "$PROXY_PORT"; then
    tail -n 80 "$PROXY_LOG_FILE" >&2 || true
    stop_managed_process "proxy" "$PROXY_PID_FILE"
    die "proxy did not become ready on $PROXY_BIND:$PROXY_PORT"
  fi
  log "proxy started (PID $(<"$PROXY_PID_FILE")) on $PROXY_BIND:$PROXY_PORT (mode: $PROXY_MODE)"
}

basic_auth_curl_args() {
  local inline="${DSH_PROXY_BASIC_AUTH:-}"
  if [[ "$inline" == "off" ]]; then
    return 0
  fi
  local credential user password
  if [[ -n "$inline" ]]; then
    credential="$inline"
  else
    credential="$(<"$BASIC_AUTH_FILE")"
  fi
  user="${credential%%:*}"
  password="${credential#*:}"
  printf '%s\n' --user "${user}:${password}"
}

# Acceptance: the board answers through the proxy, and the fence still refuses
# the same request when the proxy is bypassed.
verify_all() {
  [[ -n "$CURL_BIN" && -x "$CURL_BIN" ]] || die "curl was not found"
  local -a auth=()
  mapfile -t auth < <(basic_auth_curl_args)

  local board_proxied board_direct gui
  board_proxied="$("$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 10 ${auth[@]+"${auth[@]}"} \
    -H "Origin: $PUBLIC_ORIGIN" -H 'Sec-Fetch-Site: same-origin' \
    "${PUBLIC_URL}api/task-board/state" || true)"
  board_direct="$("$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Host: $PUBLIC_AUTHORITY" -H "Origin: $PUBLIC_ORIGIN" -H 'Sec-Fetch-Site: same-origin' \
    "http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/task-board/state" || true)"
  gui="$("$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 10 ${auth[@]+"${auth[@]}"} "$PUBLIC_URL" || true)"

  log "verify: board through proxy=$board_proxied, board bypassing proxy=$board_direct, GUI=$gui"
  [[ "$board_proxied" == "200" ]] || die "board did not answer 200 through the proxy (got $board_proxied)"
  [[ "$board_direct" == "403" ]] || die "the fence no longer refuses a proxy-less request (got $board_direct)"
  # A bare curl carries no browser-auth cookie, so the harness answers 401 on
  # the shell (the browser redeems the launch token into that cookie and gets
  # 200). Either answer proves the listener is serving through the proxy.
  [[ "$gui" == "200" || "$gui" == "401" ]] || die "GUI did not answer through the proxy (got $gui)"
  log "verify: OK"
}

start_all() {
  assert_prerequisites
  prepare_runtime
  start_harness
  start_proxy

  local ready_url
  if ! ready_url="$(wait_for_startup_url)"; then
    die "Harness is listening but did not print its authenticated URL"
  fi
  printf '%s\n' "$ready_url" > "$RUNTIME_DIR/ready-url.txt"
  log "ready: $ready_url"
  if [[ "$PROXY_MODE" == "task-board" ]]; then
    log "proxy entry: $PUBLIC_URL (basic-auth credential: $BASIC_AUTH_FILE)"
  fi
}

stop_all() {
  stop_managed_process "proxy" "$PROXY_PID_FILE"
  stop_managed_process "Harness" "$DSH_PID_FILE"
  kill_port_listeners
}

status_all() {
  log "mode: $PROXY_MODE"
  if pid_is_running "$DSH_PID_FILE"; then
    log "Harness: running (PID $(<"$DSH_PID_FILE"))"
  else
    log "Harness: stopped"
  fi
  if pid_is_running "$PROXY_PID_FILE"; then
    log "proxy: running (PID $(<"$PROXY_PID_FILE"))"
  else
    log "proxy: stopped"
  fi
  if tcp_reachable "$INTERNAL_HOST" "$INTERNAL_PORT"; then
    log "listener: reachable at $INTERNAL_HOST:$INTERNAL_PORT"
  else
    log "listener: unreachable at $INTERNAL_HOST:$INTERNAL_PORT"
  fi
  if tcp_reachable "$INTERNAL_HOST" "$PROXY_PORT"; then
    log "forward: reachable at $PROXY_BIND:$PROXY_PORT"
  else
    log "forward: unreachable at $PROXY_BIND:$PROXY_PORT"
  fi
}

case "${1:-start}" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  restart)
    stop_all
    start_all
    ;;
  status)
    status_all
    ;;
  verify)
    verify_all
    ;;
  logs)
    tail -n 100 -F "$DSH_LOG_FILE" "$PROXY_LOG_FILE"
    ;;
  *)
    printf 'Usage: %s {start|stop|restart|status|verify|logs}\n' "$0" >&2
    exit 2
    ;;
esac
