#!/usr/bin/env node
/**
 * Report the persisted turn state of a DSH session event log.
 *
 * The session log is a concatenation of independent zstd frames (one per
 * flush), and Node's zstd APIs stop at the first frame, so this walks every
 * frame magic in the tail of the file and decodes each frame separately.
 *
 * Output: one JSON line `{"maxTurnEnd":N,"lastBoundary":"turn/end"}`.
 * A cutover script uses it to wait for the in-flight turn to finish instead of
 * guessing with a timer: the last turn boundary is `turn/end` only when no
 * turn is running.
 *
 * Usage: dsh-session-turn-state.mjs <session.v4.jsonl.zstd>
 *
 * @module dsh-session-turn-state
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined || file === '') {
  process.stderr.write('usage: dsh-session-turn-state.mjs <session.v4.jsonl.zstd>\n')
  process.exit(2)
}

/** Only the tail matters: turn boundaries are recent, and the log grows unbounded. */
const WINDOW_BYTES = 1 << 20
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let buffer
try {
  buffer = readFileSync(file)
} catch (error) {
  process.stderr.write(`dsh-session-turn-state: cannot read ${file}: ${error.message}\n`)
  process.exit(3)
}

let maxTurnEnd = 0
let lastBoundary = 'none'
let lastBoundarySeq = -1

let index = buffer.indexOf(MAGIC, Math.max(0, buffer.length - WINDOW_BYTES))
while (index !== -1) {
  let chunk
  try {
    chunk = zstdDecompressSync(buffer.subarray(index)).toString('utf8')
  } catch {
    // A partially written final frame, or a magic that appears inside payload
    // bytes: skip this candidate and keep walking.
    index = buffer.indexOf(MAGIC, index + 4)
    continue
  }
  index = buffer.indexOf(MAGIC, index + 4)

  for (const line of chunk.split('\n')) {
    if (line === '' || !line.includes('turn/')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    const turn = Number(event.data?.turn ?? 0)
    if (event.type === 'turn/end' && turn > maxTurnEnd) maxTurnEnd = turn
    const seq = Number(event.seq ?? -1)
    if (seq >= lastBoundarySeq) {
      lastBoundarySeq = seq
      lastBoundary = event.type
    }
  }
}

process.stdout.write(`${JSON.stringify({ maxTurnEnd, lastBoundary, lastBoundarySeq })}\n`)
