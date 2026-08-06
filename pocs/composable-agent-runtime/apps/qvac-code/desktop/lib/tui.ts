// The one file in this trio that touches I/O: process input/output, timers,
// and the terminal's raw mode. Everything about *what* to draw lives in
// tui-render.ts; this file only owns *when* to draw and how to read a key
// or a line back.
import { emitKeypressEvents, type Key } from 'node:readline'
import { createInterface, type Interface as ReadlinePromiseInterface } from 'node:readline/promises'
import { createTheme, isColorEnabledFor, visibleWidth } from './tui-theme.ts'
import { renderScreen, renderStatusLine, type ScreenModel } from './tui-render.ts'

const REDRAW_THROTTLE_MS = 50
const DEFAULT_TERMINAL_WIDTH = 80
const DEFAULT_TERMINAL_HEIGHT = 24
const ERROR_PREFIX = '✖ '
const YES_ANSWER = 'y'
const NO_ANSWER = 'n'

// Narrow relative to the concrete `tty.ReadStream`/`net.Socket` classes,
// but wide enough to use directly with `node:readline` (which needs a real
// `NodeJS.ReadableStream`) without a cast: real `process.stdin` satisfies
// this structurally, and a test double only needs to implement Readable.
export interface TuiStdin extends NodeJS.ReadableStream {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): this
}

export interface TuiStdoutPort {
  write(chunk: string): void
  readonly columns?: number
  readonly rows?: number
  readonly isTTY?: boolean
}

export interface TuiPorts {
  readonly stdout: TuiStdoutPort
  readonly stdin: TuiStdin
  readonly now: () => number
}

export interface ApprovalPromptInput {
  readonly toolName: string
  readonly summary: string
  readonly detail: readonly string[]
}

export interface Tui {
  update(model: Partial<ScreenModel>): void
  notice(text: string): void
  error(text: string): void
  /**
   * Renders an approval prompt and resolves with the answer. If `signal`
   * aborts before the user answers, this promise deliberately never settles
   * -- collapsing "aborted" into `false` would render an unanswered
   * approval as a denial nobody made (see approval.ts's own withdrawn /
   * unanswered distinction). The caller is expected to `Promise.race` this
   * against its own abort-aware promise.
   */
  promptApproval(prompt: ApprovalPromptInput, signal: AbortSignal): Promise<boolean>
  /** Reads one line, for a free-text answer. Rejects if `signal` aborts. */
  question(text: string, signal: AbortSignal): Promise<string>
  close(): void
}

function emptyHeader() {
  return {
    projectLabel: '',
    projectRoot: '',
    executorId: '',
    model: '',
    pairing: { kind: 'offline' as const },
    skills: []
  }
}

function initialModel(ports: TuiPorts): ScreenModel {
  return {
    header: emptyHeader(),
    sessions: [],
    turn: null,
    approval: null,
    notices: [],
    width: ports.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
    height: ports.stdout.rows ?? DEFAULT_TERMINAL_HEIGHT,
    now: ports.now()
  }
}

export function createTui(ports: TuiPorts) {
  const theme = createTheme({ enabled: isColorEnabledFor(ports.stdout.isTTY) })
  let model = initialModel(ports)
  let closed = false
  let redrawTimer: ReturnType<typeof setTimeout> | null = null
  let lastDrawAt = -Infinity
  let lastFrameLineCount = 0
  let rawModeActive = false
  let keypressEventsReady = false
  let lineInterface: ReadlinePromiseInterface | null = null
  // Held so close() can tear down a prompt that is still waiting: otherwise the
  // keypress listener outlives the UI and a later keystroke resolves an
  // approval for a run that is already gone.
  let activePromptCleanup: (() => void) | null = null

  process.once('exit', restoreStdinSync)

  function draw() {
    if (closed) return
    const frame = renderScreen({ ...model, now: ports.now() }, theme)
    // Move the cursor up to the top of the previous frame and clear
    // downward before repainting, instead of clearing the whole screen --
    // this leaves scrollback (and anything notice()/error() printed
    // between frames) alone.
    const erase = lastFrameLineCount > 0 ? `\x1b[${lastFrameLineCount}A\x1b[0J` : ''
    ports.stdout.write(erase + frame.join('\n') + (frame.length > 0 ? '\n' : ''))
    // Count the terminal rows the frame actually occupies, not its array
    // length. A line wider than the terminal wraps onto further rows, and the
    // unpaired invite URI is deliberately over-wide -- which is the default
    // first-run state, so counting elements would drift the display on every
    // redraw for every new user.
    lastFrameLineCount = countTerminalRows(frame, model.width)
  }

  function scheduleRedraw() {
    if (closed || redrawTimer != null) return
    const elapsed = ports.now() - lastDrawAt
    const delay = Math.max(REDRAW_THROTTLE_MS - elapsed, 0)
    redrawTimer = setTimeout(function fireRedraw() {
      redrawTimer = null
      lastDrawAt = ports.now()
      draw()
    }, delay)
  }

  function update(partial: Partial<ScreenModel>) {
    if (closed) return
    model = { ...model, ...partial }
    scheduleRedraw()
  }

  function notice(text: string) {
    if (closed) return
    // A notice is a discrete, scrolling status line (the `▸ ` CLI
    // convention), not part of the redrawn frame -- forget the erase count
    // so the next draw() does not try to cursor-up back through it.
    ports.stdout.write(`${renderStatusLine(text, theme)}\n`)
    lastFrameLineCount = 0
  }

  function error(text: string) {
    if (closed) return
    ports.stdout.write(`${theme.error(`${ERROR_PREFIX}${text}`)}\n`)
    lastFrameLineCount = 0
  }

  function ensureKeypressEvents() {
    if (keypressEventsReady) return
    emitKeypressEvents(ports.stdin)
    keypressEventsReady = true
  }

  function restoreStdinSync() {
    if (rawModeActive) ports.stdin.setRawMode?.(false)
  }

  function promptApproval(prompt: ApprovalPromptInput, signal: AbortSignal) {
    update({
      approval: {
        toolName: prompt.toolName,
        summary: prompt.summary,
        detail: prompt.detail,
        decidedBy: null,
        verdict: null
      }
    })
    notice(`Approve ${prompt.toolName}? [y/n]`)

    const useRawMode = ports.stdin.isTTY === true && ports.stdin.setRawMode != null
    const answered = useRawMode ? promptApprovalRaw(signal) : promptApprovalLineMode(signal)
    return answered.then(function clearApprovalPrompt(value) {
      update({ approval: null })
      return value
    })
  }

  function promptApprovalRaw(signal: AbortSignal) {
    return new Promise<boolean>(function executor(resolve) {
      if (signal.aborted) return // never settles; see the Tui.promptApproval doc comment

      ensureKeypressEvents()
      ports.stdin.setRawMode?.(true)
      rawModeActive = true

      function cleanup() {
        ports.stdin.removeListener('keypress', onKeypress)
        signal.removeEventListener('abort', onAbort)
        ports.stdin.setRawMode?.(false)
        rawModeActive = false
        if (activePromptCleanup === cleanup) activePromptCleanup = null
      }

      function onKeypress(_chunk: string, key: Key | undefined) {
        // Raw mode disables ISIG, so Ctrl+C arrives here as a keystroke rather
        // than a signal. Without this the terminal looks hung during a prompt.
        if (key?.ctrl === true && key.name === 'c') {
          cleanup()
          process.kill(process.pid, 'SIGINT')
          return
        }
        // A modifier combination is not an answer: Ctrl+Y must not approve a
        // filesystem write.
        if (key?.ctrl === true || key?.meta === true) return
        const name = key?.name?.toLowerCase()
        if (name === YES_ANSWER) {
          cleanup()
          resolve(true)
          return
        }
        if (name === NO_ANSWER) {
          cleanup()
          resolve(false)
          return
        }
        // Anything else, including a bare Enter, is not an answer -- keep
        // waiting, per the interface contract.
      }

      function onAbort() {
        cleanup()
        // Deliberately does not resolve or reject; see the doc comment.
      }

      // Discard anything typed before this prompt appeared. A `y` queued for an
      // earlier question would otherwise silently approve this tool call.
      ports.stdin.read?.()
      activePromptCleanup = cleanup
      ports.stdin.on('keypress', onKeypress)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function promptApprovalLineMode(signal: AbortSignal) {
    while (!signal.aborted) {
      const line = await readLineOrAbort(signal)
      if (line == null) break // aborted mid-read
      const answer = line.trim().toLowerCase()
      if (answer === YES_ANSWER) return true
      if (answer === NO_ANSWER) return false
      notice(`Please answer '${YES_ANSWER}' or '${NO_ANSWER}'.`)
    }
    return neverSettlingPromise()
  }

  async function readLineOrAbort(signal: AbortSignal) {
    const rl = ensureLineInterface()
    try {
      return await rl.question('', { signal })
    } catch (err) {
      if (signal.aborted) return null
      throw err
    }
  }

  function ensureLineInterface() {
    // Line reading and raw-mode keypress reading are mutually exclusive on
    // the same stream; if a previous raw-mode prompt is still marked
    // active (it should not be, once cleanup() above has run) drop it
    // defensively rather than reading through a stream stuck in raw mode.
    if (rawModeActive) {
      ports.stdin.setRawMode?.(false)
      rawModeActive = false
    }
    if (lineInterface == null) {
      lineInterface = createInterface({ input: ports.stdin, terminal: false })
    }
    return lineInterface
  }

  async function question(text: string, signal: AbortSignal) {
    notice(text)
    const rl = ensureLineInterface()
    return rl.question('', { signal })
  }

  function close() {
    if (closed) return
    closed = true
    if (redrawTimer != null) {
      clearTimeout(redrawTimer)
      redrawTimer = null
    }
    activePromptCleanup?.()
    activePromptCleanup = null
    restoreStdinSync()
    lineInterface?.close()
    lineInterface = null
    process.removeListener('exit', restoreStdinSync)
  }

  const tui: Tui = { update, notice, error, promptApproval, question, close }
  return tui
}

function neverSettlingPromise() {
  return new Promise<boolean>(function executor() {
    // Deliberately never calls resolve/reject; see Tui.promptApproval.
  })
}

/**
 * Terminal rows a frame occupies once the terminal wraps over-wide lines. A
 * zero-width line still occupies one row.
 */
function countTerminalRows(frame: readonly string[], width: number) {
  const safeWidth = Math.max(width, 1)
  let rows = 0
  for (const line of frame) {
    rows += Math.max(1, Math.ceil(visibleWidth(line) / safeWidth))
  }
  return rows
}
