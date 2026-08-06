// Pure rendering: every function here takes data and a theme and returns
// lines of text. No process.stdout, no timers, no Date.now() -- "now" is
// always an input -- so this file can be exercised with plain fixtures and
// never corrupts a real terminal no matter what it is fed.
import type {
  CodeApprovalDecision,
  CodeApprovalVerdict,
  CodeDeciderRef,
  CodeTranscriptBlock,
  CodeTurnStatus,
  CodeTurnView
} from '@qvac-poc/qvac-code-shared'
import { visibleWidth, type Theme } from './tui-theme.ts'

export type HeaderPairing =
  | { readonly kind: 'unpaired'; readonly inviteUri: string }
  | { readonly kind: 'paired'; readonly devices: readonly string[] }
  | { readonly kind: 'offline' }

export interface HeaderModel {
  readonly projectLabel: string
  readonly projectRoot: string
  readonly executorId: string
  readonly model: string
  readonly pairing: HeaderPairing
  readonly skills: readonly string[]
}

export interface SessionRowModel {
  readonly sessionId: string
  readonly title: string
  readonly turnCount: number
  readonly status: CodeTurnStatus | 'idle'
  readonly updatedAt: number
  readonly selected: boolean
}

export interface ApprovalModel {
  readonly toolName: string
  readonly summary: string
  readonly detail: readonly string[]
  readonly decidedBy: string | null
  readonly verdict: CodeApprovalVerdict | null
}

export interface ScreenModel {
  readonly header: HeaderModel
  readonly sessions: readonly SessionRowModel[]
  readonly turn: CodeTurnView | null
  readonly approval: ApprovalModel | null
  readonly notices: readonly string[]
  readonly width: number
  readonly height: number
  readonly now: number
}

const MIN_DIMENSION = 1
const STATUS_PREFIX = '▸ '
const ERROR_PREFIX = '✖ '
const SELECTED_MARKER = '▸ '
const UNSELECTED_MARKER = '  '
const EMPTY_SESSIONS_HINT = 'No sessions yet -- start one from your phone.'
const THINKING_MAX_LINES = 3
const TOOL_LINE_INDENT = '  '
const TOOL_OUTCOME_INDENT = '    '
const FIELD_GAP = '  '
const PENDING_TOOL_SUFFIX = ' …'
const STALE_APPROVAL_NOTE = 'This turn had already finished when this was decided.'
const AWAITING_DECISION_LABEL = 'awaiting decision'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const BOX_TOP_LEFT = '┌'
const BOX_TOP_RIGHT = '┐'
const BOX_BOTTOM_LEFT = '└'
const BOX_BOTTOM_RIGHT = '┘'
const BOX_HORIZONTAL = '─'
const BOX_VERTICAL = '│'
// Below this width a border has no room left to read as a border once its
// four corner/edge characters are subtracted -- fall back to plain, clipped
// lines rather than emitting corner glyphs squeezed into a handful of
// columns.
const BOX_MIN_WIDTH = 8
// "│ " on the left, " │" on the right.
const BOX_OVERHEAD = 4

// Mirrors tui-theme.ts's own reset code. Duplicated rather than exported
// from there: clipToWidth needs it only as a last-resort terminator when a
// clip cuts through a still-open color run, which is a rendering concern,
// not a theme concern.
const ANSI_RESET_SUFFIX = '\x1b[0m'
const ANSI_SPLIT_PATTERN = /(\x1b\[[0-9;]*m)/g
const ANSI_SEGMENT_PATTERN = /^\x1b\[[0-9;]*m$/
const WORD_BOUNDARY_PATTERN = /\s+/

export function renderHeader(model: HeaderModel, theme: Theme, width: number): readonly string[] {
  const safeWidth = Math.max(width, MIN_DIMENSION)
  const bodyLines = [
    theme.dim(model.projectRoot),
    `model ${model.model}${FIELD_GAP}${FIELD_GAP}executor ${model.executorId}`,
    renderPairingSummary(model.pairing, theme),
    ...(model.skills.length > 0 ? [`skills ${model.skills.join(', ')}`] : [])
  ]
  const box = renderBoxedLines(model.projectLabel, bodyLines, theme, safeWidth)
  if (model.pairing.kind !== 'unpaired') return box
  // The invite URI is what the user copies onto their phone. Wrapping it
  // would insert a line break the phone's paste target can't undo, and
  // coloring it would risk embedding ANSI bytes in what gets copied if the
  // terminal's own copy handling is not escape-aware -- so it is emitted
  // completely untouched, on its own line, even past `width`.
  return [...box, model.pairing.inviteUri]
}

// Deviates from the sketched `(sessions, theme, width)` signature by adding
// `now`: relative ages ("2m ago") cannot be computed otherwise, and the
// file-level rule is "no Date.now() -- pass now in", which this function
// cannot honor without the parameter. See the PR notes for this call.
export function renderSessions(
  sessions: readonly SessionRowModel[],
  theme: Theme,
  width: number,
  now: number
): readonly string[] {
  const safeWidth = Math.max(width, MIN_DIMENSION)
  if (sessions.length === 0) {
    return [clipToWidth(theme.dim(EMPTY_SESSIONS_HINT), safeWidth)]
  }
  return sessions.map((session) => renderSessionRow(session, theme, safeWidth, now))
}

export function renderTranscript(
  turn: CodeTurnView | null,
  theme: Theme,
  width: number,
  now: number
): readonly string[] {
  if (turn == null) return []
  const safeWidth = Math.max(width, MIN_DIMENSION)
  const lines: string[] = []
  for (const block of turn.blocks) {
    lines.push(...renderTranscriptBlock(block, theme, safeWidth, now))
  }
  return lines
}

export function renderApproval(approval: ApprovalModel, theme: Theme, width: number): readonly string[] {
  const safeWidth = Math.max(width, MIN_DIMENSION)
  const wrapWidth = computeInteriorWidth(safeWidth)
  const decisionLine = renderModelDecisionLine(approval.verdict, approval.decidedBy, theme)
  const bodyLines = [
    ...wrapPlainText(approval.summary, wrapWidth),
    ...approval.detail.flatMap((entry) => wrapPlainText(entry, wrapWidth)),
    decisionLine
  ]
  return renderBoxedLines(approval.toolName, bodyLines, theme, safeWidth)
}

export function renderScreen(model: ScreenModel, theme: Theme): readonly string[] {
  const safeWidth = Math.max(model.width, MIN_DIMENSION)
  const safeHeight = Math.max(model.height, MIN_DIMENSION)

  const header = renderHeader(model.header, theme, safeWidth)
  const sessions = renderSessions(model.sessions, theme, safeWidth, model.now)
  const approval = model.approval != null ? renderApproval(model.approval, theme, safeWidth) : []
  const notices = model.notices.map((notice) => clipToWidth(theme.dim(notice), safeWidth))
  const transcript = renderTranscript(model.turn, theme, safeWidth, model.now)

  const fixedLineCount = header.length + sessions.length + approval.length + notices.length
  const transcriptBudget = Math.max(safeHeight - fixedLineCount, 0)
  // Drop the oldest transcript lines first: the newest output and the
  // approval block (already counted in `fixedLineCount` above, so never
  // dropped here) are what the person at the keyboard needs to see when the
  // terminal is too short to show a whole turn.
  const visibleTranscript =
    transcriptBudget >= transcript.length ? transcript : transcript.slice(transcript.length - transcriptBudget)

  const frame = [...header, ...sessions, ...visibleTranscript, ...approval, ...notices]
  // The header and session rows alone can exceed a very short terminal, leaving
  // no transcript to drop. Clip the frame itself so the contract holds at any
  // height, keeping the tail: an approval prompt nobody can see is worse than a
  // missing header.
  if (frame.length <= safeHeight) return frame
  return frame.slice(frame.length - safeHeight)
}

export function renderStatusLine(text: string, theme: Theme): string {
  return theme.dim(`${STATUS_PREFIX}${text}`)
}

// ---- header ----

function renderPairingSummary(pairing: HeaderPairing, theme: Theme): string {
  if (pairing.kind === 'unpaired') return theme.warning('not paired (invite below)')
  if (pairing.kind === 'offline') return theme.muted('offline')
  const count = pairing.devices.length
  return theme.success(`paired · ${count} device${count === 1 ? '' : 's'}`)
}

// ---- sessions ----

function renderSessionRow(session: SessionRowModel, theme: Theme, width: number, now: number): string {
  const marker = session.selected ? SELECTED_MARKER : UNSELECTED_MARKER
  const status = statusColorFor(session.status, theme)(session.status)
  const age = formatRelativeAge(now, session.updatedAt)
  const turns = `${session.turnCount} turn${session.turnCount === 1 ? '' : 's'}`
  const line = `${marker}${session.title}${FIELD_GAP}${turns}${FIELD_GAP}${status}${FIELD_GAP}${age}`
  return clipToWidth(line, width)
}

function statusColorFor(status: CodeTurnStatus | 'idle', theme: Theme): (text: string) => string {
  if (status === 'claimed' || status === 'running') return theme.primary
  if (status === 'awaiting-approval') return theme.warning
  if (status === 'completed') return theme.success
  if (status === 'failed' || status === 'cancelled') return theme.error
  // 'queued' and 'idle' both mean "nothing active right now" -- see the
  // `muted`-for-grey note in tui-theme.ts.
  return theme.muted
}

function formatRelativeAge(now: number, updatedAt: number): string {
  const deltaMs = Math.max(now - updatedAt, 0)
  if (deltaMs < MS_PER_MINUTE) return 'just now'
  if (deltaMs < MS_PER_HOUR) return `${Math.floor(deltaMs / MS_PER_MINUTE)}m ago`
  if (deltaMs < MS_PER_DAY) return `${Math.floor(deltaMs / MS_PER_HOUR)}h ago`
  return `${Math.floor(deltaMs / MS_PER_DAY)}d ago`
}

// ---- transcript ----

type ToolBlock = Extract<CodeTranscriptBlock, { kind: 'tool' }>
type ApprovalBlock = Extract<CodeTranscriptBlock, { kind: 'approval' }>

// `now` is threaded through from renderTranscript for signature symmetry
// with the rest of this file's "pass now in, never read the clock" rule; no
// block kind currently carries a per-block timestamp to render relative to
// it, so it is unused today and reserved for that future case.
function renderTranscriptBlock(
  block: CodeTranscriptBlock,
  theme: Theme,
  width: number,
  now: number
): readonly string[] {
  if (block.kind === 'assistant') {
    return wrapPlainText(block.text, width).map((line) => clipToWidth(line, width))
  }
  if (block.kind === 'thinking') return renderThinkingBlock(block.text, theme, width)
  if (block.kind === 'tool') return renderToolBlock(block, theme, width)
  if (block.kind === 'approval') return renderApprovalBlock(block, theme, width)
  if (block.kind === 'error') return renderErrorBlock(block.message, theme, width)
  return wrapPlainText(block.text, width).map((line) => clipToWidth(theme.dim(line), width))
}

function renderThinkingBlock(text: string, theme: Theme, width: number): string[] {
  const wrapped = wrapPlainText(text, width)
  if (wrapped.length <= THINKING_MAX_LINES) {
    return wrapped.map((line) => clipToWidth(theme.dim(line), width))
  }
  const hiddenCount = wrapped.length - THINKING_MAX_LINES
  const shown = wrapped.slice(0, THINKING_MAX_LINES).map((line) => clipToWidth(theme.dim(line), width))
  shown.push(clipToWidth(theme.dim(`… ${hiddenCount} more lines`), width))
  return shown
}

function renderToolBlock(block: ToolBlock, theme: Theme, width: number): string[] {
  const header = `${TOOL_LINE_INDENT}${theme.primary(block.name)}${FIELD_GAP}${block.request}`
  if (block.outcome == null) {
    return [clipToWidth(`${header}${PENDING_TOOL_SUFFIX}`, width)]
  }
  const outcomeText = theme.dim(block.outcome.summary)
  const combined = `${header}${FIELD_GAP}${outcomeText}`
  if (visibleWidth(combined) <= width) {
    return [clipToWidth(combined, width)]
  }
  return [clipToWidth(header, width), clipToWidth(`${TOOL_OUTCOME_INDENT}${outcomeText}`, width)]
}

function renderApprovalBlock(block: ApprovalBlock, theme: Theme, width: number): string[] {
  const wrapWidth = computeInteriorWidth(width)
  const decisionLine =
    block.decision != null ? renderDecisionLine(block.decision, theme) : theme.warning(AWAITING_DECISION_LABEL)
  const bodyLines = [
    ...wrapPlainText(block.summary, wrapWidth),
    ...block.detail.flatMap((entry) => wrapPlainText(entry, wrapWidth)),
    decisionLine
  ]
  const box = renderBoxedLines(block.name, bodyLines, theme, width)
  if (!block.stale) return box
  // A stale decision resolved the gate after its turn had already finished
  // (see transcript.ts's `stale` comment): the tool it would have gated
  // never ran on the strength of it, so say that plainly rather than
  // presenting a decision that still looks live.
  return [...box, clipToWidth(theme.dim(STALE_APPROVAL_NOTE), width)]
}

function renderErrorBlock(message: string, theme: Theme, width: number): string[] {
  const wrapWidth = Math.max(width - visibleWidth(ERROR_PREFIX), MIN_DIMENSION)
  const indent = ' '.repeat(ERROR_PREFIX.length)
  return wrapPlainText(message, wrapWidth).map((line, index) => {
    const prefix = index === 0 ? ERROR_PREFIX : indent
    return clipToWidth(theme.error(`${prefix}${line}`), width)
  })
}

// ---- approval (standalone model, e.g. a live prompt) ----

function renderModelDecisionLine(
  verdict: CodeApprovalVerdict | null,
  decidedBy: string | null,
  theme: Theme
): string {
  if (verdict == null) return theme.warning(AWAITING_DECISION_LABEL)
  const colored = verdictColor(theme, verdict)(verdict)
  return decidedBy != null && decidedBy.length > 0 ? `${colored} · ${decidedBy}` : colored
}

function renderDecisionLine(decision: CodeApprovalDecision, theme: Theme): string {
  const colored = verdictColor(theme, decision.verdict)(decision.verdict)
  const decider = formatDecider(decision.decidedBy)
  return decider.length > 0 ? `${colored} · ${decider}` : colored
}

// withdrawn/unanswered mean nobody actually decided (see approval.ts's
// `toHarnessResolution` comment) -- they must never read as "denied", so
// they get dimmed instead of the error color a real denial gets.
function verdictColor(theme: Theme, verdict: CodeApprovalVerdict): (text: string) => string {
  if (verdict === 'approved') return theme.success
  if (verdict === 'denied') return theme.error
  return theme.dim
}

function formatDecider(ref: CodeDeciderRef): string {
  if (ref.kind === 'executor') return ref.executorId
  if (ref.kind === 'peer') return ref.deviceRef
  return ref.rule
}

// ---- box drawing ----

function computeInteriorWidth(safeWidth: number): number {
  return safeWidth >= BOX_MIN_WIDTH ? safeWidth - BOX_OVERHEAD : Math.max(safeWidth, MIN_DIMENSION)
}

function renderBoxedLines(
  title: string | null,
  bodyLines: readonly string[],
  theme: Theme,
  width: number
): string[] {
  const safeWidth = Math.max(width, MIN_DIMENSION)
  if (safeWidth < BOX_MIN_WIDTH) {
    const flat = title != null && title.length > 0 ? [title, ...bodyLines] : bodyLines
    return flat.map((line) => clipToWidth(line, safeWidth))
  }
  const inner = computeInteriorWidth(safeWidth)
  const lines: string[] = [renderBoxTopBorder(title, theme, safeWidth)]
  for (const raw of bodyLines) {
    const fitted = padEndVisible(clipToWidth(raw, inner), inner)
    lines.push(clipToWidth(`${BOX_VERTICAL} ${fitted} ${BOX_VERTICAL}`, safeWidth))
  }
  lines.push(renderBoxBottomBorder(safeWidth))
  return lines
}

function renderBoxTopBorder(title: string | null, theme: Theme, safeWidth: number): string {
  if (title == null || title.length === 0) {
    return `${BOX_TOP_LEFT}${BOX_HORIZONTAL.repeat(Math.max(safeWidth - 2, 0))}${BOX_TOP_RIGHT}`
  }
  const labelBudget = Math.max(safeWidth - BOX_OVERHEAD, 0)
  const label = theme.bold(clipToWidth(title, labelBudget))
  const prefix = `${BOX_TOP_LEFT}${BOX_HORIZONTAL} ${label} `
  const fillerWidth = Math.max(safeWidth - visibleWidth(prefix) - 1, 0)
  return clipToWidth(`${prefix}${BOX_HORIZONTAL.repeat(fillerWidth)}${BOX_TOP_RIGHT}`, safeWidth)
}

function renderBoxBottomBorder(safeWidth: number): string {
  return `${BOX_BOTTOM_LEFT}${BOX_HORIZONTAL.repeat(Math.max(safeWidth - 2, 0))}${BOX_BOTTOM_RIGHT}`
}

// ---- text wrapping ----

function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(width, MIN_DIMENSION)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    lines.push(...wrapParagraph(paragraph, safeWidth))
  }
  return lines
}

function wrapParagraph(paragraph: string, width: number): string[] {
  const words = paragraph.split(WORD_BOUNDARY_PATTERN).filter((word) => word.length > 0)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (visibleWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    if (visibleWidth(word) <= width) {
      current = word
      continue
    }
    // A single token wider than the whole line (a long path, URL, hash) --
    // hard-break it rather than overflowing, since there is no word
    // boundary left to wrap on.
    const chunks = hardBreak(word, width)
    lines.push(...chunks.slice(0, -1))
    current = chunks.at(-1) ?? ''
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function hardBreak(word: string, width: number): string[] {
  const chunks: string[] = []
  let chunk = ''
  let chunkWidth = 0
  for (const char of word) {
    const charWidth = visibleWidth(char)
    if (chunkWidth + charWidth > width && chunk.length > 0) {
      chunks.push(chunk)
      chunk = ''
      chunkWidth = 0
    }
    chunk += char
    chunkWidth += charWidth
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks.length > 0 ? chunks : ['']
}

// ---- width-safe clipping/padding ----

function padEndVisible(text: string, width: number): string {
  const currentWidth = visibleWidth(text)
  if (currentWidth >= width) return text
  return text + ' '.repeat(width - currentWidth)
}

// Clips to at most `width` visible columns without ever splitting an ANSI
// escape sequence in half, so a truncated colored line cannot leak raw
// escape bytes into the terminal.
function clipToWidth(text: string, width: number): string {
  const safeWidth = Math.max(width, 0)
  if (safeWidth === 0) return ''
  if (visibleWidth(text) <= safeWidth) return text
  let result = ''
  let consumed = 0
  let hasAnsi = false
  for (const segment of text.split(ANSI_SPLIT_PATTERN)) {
    if (segment.length === 0) continue
    if (ANSI_SEGMENT_PATTERN.test(segment)) {
      result += segment
      hasAnsi = true
      continue
    }
    const fitted = takeWithinWidth(segment, safeWidth - consumed)
    result += fitted.text
    consumed += fitted.width
    if (fitted.truncated) {
      // The clip landed inside a still-open color run -- close it so the
      // truncation cannot bleed color into whatever text follows on the
      // same terminal line (e.g. this function's own caller padding it).
      return hasAnsi ? `${result}${ANSI_RESET_SUFFIX}` : result
    }
  }
  return result
}

function takeWithinWidth(segment: string, budget: number): { text: string; width: number; truncated: boolean } {
  let text = ''
  let width = 0
  for (const char of segment) {
    const charWidth = visibleWidth(char)
    if (width + charWidth > budget) return { text, width, truncated: true }
    text += char
    width += charWidth
  }
  return { text, width, truncated: false }
}
