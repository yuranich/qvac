import { decodeJournalBody } from './journal.ts'
import type { CodeTranscriptEntryInput } from './transcript.ts'

/**
 * A turn's journal `seq` does two jobs at once: it disambiguates the
 * operationId of every append by the same writer, and it is the order the
 * transcript renders in (`projectTurn` buckets by writer and sorts each bucket
 * by seq). Several modules on one executor append to the same turn as the same
 * writer, so they must share one counter -- give each its own numbering band and
 * dedup still works while the transcript silently reorders, detaching an
 * approval from the tool call it gated.
 */
export interface JournalSeqAllocator {
  next(): number
  peek(): number
}

export function createJournalSeqAllocator(start: number): JournalSeqAllocator {
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new Error(`Journal seq start must be a non-negative integer: ${start}`)
  }
  let next = start
  return {
    next() {
      const value = next
      next += 1
      return value
    },
    peek() {
      return next
    }
  }
}

/**
 * Where a writer's numbering resumes for a turn. Zero for a turn nobody has
 * written to yet, and one past the highest existing seq otherwise -- which is
 * what lets a restarted executor append to a turn it claimed in an earlier
 * process without colliding with its own earlier operationIds. The executor id
 * is stable across restarts by design, so "the same writer, a different process"
 * is a case that genuinely happens.
 */
export function resumeJournalSeq(
  entries: readonly CodeTranscriptEntryInput[],
  writer: string
) {
  let highest = -1
  for (const entry of entries) {
    const body = decodeJournalBody(entry.body)
    if (body == null || body.writer !== writer) continue
    if (body.seq > highest) highest = body.seq
  }
  return highest + 1
}
