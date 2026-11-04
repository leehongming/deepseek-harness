#!/usr/bin/env node
/**
 * Public-authority reverse proxy for the DSH Web GUI, with the task-board
 * proxy credential.
 *
 * Why this exists: the task-board Host API fences itself harder than the rest
 * of /api. Beyond the loopback socket + Host pair it accepts exactly one
 * remote shape — a request whose Host authority is listed in the plugin's
 * `trustedProxyHosts` AND which carries the server-side token the deployment
 * put in `proxyTokenEnv` (host-routes.ts, isTrustedTaskBoardRequest). A raw
 * TCP forward (socat) rewrites nothing, so the browser's non-loopback Host
 * always failed that fence and the panel rendered board.hostError.forbidden.
 *
 * This proxy is the "authenticated reverse proxy" the plugin documents: it
 * authenticates the caller, then REPLACES any client-supplied
 * x-dsh-task-board-proxy-token with the deployment token before forwarding.
 * Host, Origin, Cookie and Sec-Fetch-* travel unchanged, so the harness's own
 * /api fence and browser-auth cookie keep working exactly as before.
 *
 * Authentication is mandatory by default: injecting the token for an
 * unauthenticated caller would turn /api/task-board/* into an open agent
 * control plane. `DSH_PROXY_BASIC_AUTH=off` disables it and must be a
 * deliberate choice.
 *
 * Environment:
 *   DSH_PROXY_LISTEN_HOST / DSH_PROXY_LISTEN_PORT   listen address (0.0.0.0:8211)
 *   DSH_PROXY_UPSTREAM_HOST / DSH_PROXY_UPSTREAM_PORT  loopback listener (127.0.0.1:9910)
 *   DSH_TASK_BOARD_PROXY_TOKEN_FILE                 file holding the token (0600)
 *   DSH_TASK_BOARD_PROXY_TOKEN                      inline fallback
 *   DSH_TASK_BOARD_PROXY_HEADER                     header name (x-dsh-task-board-proxy-token)
 *   DSH_PROXY_BASIC_AUTH                            "user:pass", or "off"
 *   DSH_PROXY_BASIC_AUTH_FILE                       file holding "user:pass"
 *   DSH_PROXY_QUIET                                 "1" to suppress access logs
 *
 * @module dsh-web-task-board-proxy
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'

/** Headers a proxy must not copy between the two HTTP legs. */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const LISTEN_HOST = process.env.DSH_PROXY_LISTEN_HOST ?? '0.0.0.0'
const LISTEN_PORT = Number(process.env.DSH_PROXY_LISTEN_PORT ?? '8211')
const UPSTREAM_HOST = process.env.DSH_PROXY_UPSTREAM_HOST ?? '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSH_PROXY_UPSTREAM_PORT ?? '9910')
const TOKEN_HEADER = (process.env.DSH_TASK_BOARD_PROXY_HEADER ?? 'x-dsh-task-board-proxy-token').toLowerCase()
const QUIET = process.env.DSH_PROXY_QUIET === '1'
const AUTH_REALM = 'DSH Web'

function fail(message) {
  process.stderr.write(`dsh-web-task-board-proxy: ${message}\n`)
  process.exit(1)
}

function readToken() {
  const file = process.env.DSH_TASK_BOARD_PROXY_TOKEN_FILE
  if (file !== undefined && file !== '') {
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value !== '') return value
    } catch (error) {
      fail(`cannot read DSH_TASK_BOARD_PROXY_TOKEN_FILE ${file}: ${error.message}`)
    }
  }
  const inline = (process.env.DSH_TASK_BOARD_PROXY_TOKEN ?? '').trim()
  if (inline !== '') return inline
  fail('no proxy token: set DSH_TASK_BOARD_PROXY_TOKEN_FILE (preferred) or DSH_TASK_BOARD_PROXY_TOKEN')
}

/** Parse "user:pass"; the password may contain colons. */
function parseCredential(raw) {
  const separator = raw.indexOf(':')
  if (separator <= 0) fail('basic-auth credential must read "user:pass"')
  return { user: raw.slice(0, separator), password: raw.slice(separator + 1) }
}

function readBasicAuth() {
  const inline = (process.env.DSH_PROXY_BASIC_AUTH ?? '').trim()
  if (inline === 'off') return undefined
  if (inline !== '') return parseCredential(inline)
  const file = process.env.DSH_PROXY_BASIC_AUTH_FILE
  if (file !== undefined && file !== '') {
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value !== '') return parseCredential(value)
    } catch (error) {
      fail(`cannot read DSH_PROXY_BASIC_AUTH_FILE ${file}: ${error.message}`)
    }
  }
  fail('basic auth is required by default; set DSH_PROXY_BASIC_AUTH=off only if the port is otherwise protected')
}

function constantTimeEqual(candidate, expected) {
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const TOKEN = readToken()
const BASIC = readBasicAuth()
const EXPECTED_AUTHORIZATION = BASIC === undefined
  ? undefined
  : `Basic ${Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64')}`

function authorized(req) {
  if (EXPECTED_AUTHORIZATION === undefined) return true
  const header = req.headers.authorization
  return typeof header === 'string' && constantTimeEqual(header, EXPECTED_AUTHORIZATION)
}

function deny(res) {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
    'cache-control': 'no-store',
  })
  res.end('authentication required\n')
}

/** Upstream headers: browser headers verbatim, with our token replacing any client value. */
function upstreamHeaders(req) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === TOKEN_HEADER) continue
    headers[name] = value
  }
  // Preserve the browser's authority: the task-board fence compares Host to
  // trustedProxyHosts and Origin to Host.
  headers.host = req.headers.host ?? `${UPSTREAM_HOST}:${UPSTREAM_PORT}`
  headers[TOKEN_HEADER] = TOKEN
  return headers
}

function log(req, status, startedAt) {
  if (QUIET) return
  const elapsed = Date.now() - startedAt
  process.stdout.write(`${new Date().toISOString()} ${req.method ?? '-'} ${req.url ?? '-'} -> ${status} ${elapsed}ms\n`)
}

const server = createServer((req, res) => {
  const startedAt = Date.now()
  if (!authorized(req)) {
    log(req, 401, startedAt)
    deny(res)
    return
  }

  let upstream
  try {
    upstream = httpRequest({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
    }, (upstreamRes) => {
      const headers = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(name)) continue
        headers[name] = value
      }
      log(req, upstreamRes.statusCode ?? 502, startedAt)
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      upstreamRes.pipe(res)
      upstreamRes.on('error', () => res.destroy())
      res.on('close', () => {
        if (!upstreamRes.readableEnded) upstream.destroy()
      })
    })
  } catch (error) {
    log(req, 502, startedAt)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream request failed\n')
    return
  }

  upstream.on('error', (error) => {
    log(req, 502, startedAt)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('upstream request failed\n')
      return
    }
    res.destroy()
    process.stderr.write(`dsh-web-task-board-proxy: upstream error: ${error.message}\n`)
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
})

/** Raw WebSocket handshake: every header travels, plus the token. */
server.on('upgrade', (req, socket, head) => {
  const startedAt = Date.now()
  if (!authorized(req)) {
    log(req, 401, startedAt)
    socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`)
    socket.destroy()
    return
  }

  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (name === TOKEN_HEADER) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  lines.push(`${TOKEN_HEADER}: ${TOKEN}`)
  const handshake = `${lines.join('\r\n')}\r\n\r\n`

  const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST)
  socket.setKeepAlive(true, 20_000)
  upstream.setKeepAlive(true, 20_000)
  const tearDown = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', tearDown)
  socket.on('error', tearDown)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('connect', () => {
    log(req, 101, startedAt)
    upstream.write(handshake)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
})

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const auth = BASIC === undefined ? 'disabled' : `basic ${BASIC.user}:***`
  process.stdout.write(`dsh-web-task-board-proxy: listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} (auth: ${auth})\n`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  })
}
