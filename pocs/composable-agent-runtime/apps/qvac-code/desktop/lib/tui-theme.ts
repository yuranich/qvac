// Truecolor ANSI helpers derived from the Workbench dark palette
// (wb/ui/src/tokens.ts `palette.dark`), so the desktop terminal UI reads as
// the same product as the mobile app instead of inventing its own colors.
//
// The palette lists a `grey` (#979797) token distinct from `fgMuted`
// (#7C7D7E), but the theme only exposes the seven helpers the render layer
// needs; `muted` (fgMuted) stands in for "grey" text such as the `queued`
// session status rather than adding an eighth helper for one shade of grey.

const PALETTE = {
  primary: '#16E3C1',
  fgMuted: '#7C7D7E',
  success: '#3CB371',
  warning: '#FDCA40',
  error: '#F05454'
} as const

const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_DIM = '\x1b[2m'
const HEX_COLOR_LENGTH = 6
const NO_COLOR_TERM = 'dumb'

export interface Theme {
  readonly enabled: boolean
  readonly primary: (text: string) => string
  readonly muted: (text: string) => string
  readonly success: (text: string) => string
  readonly warning: (text: string) => string
  readonly error: (text: string) => string
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
}

export interface ThemeOptions {
  readonly enabled: boolean
}

// A factory rather than a singleton: the render layer must stay pure and
// testable, so whether color is on or off is an explicit input here, never
// read from the environment by the render functions themselves.
export function createTheme(options: ThemeOptions) {
  if (!options.enabled) {
    const identity = (text: string) => text
    return {
      enabled: false,
      primary: identity,
      muted: identity,
      success: identity,
      warning: identity,
      error: identity,
      bold: identity,
      dim: identity
    }
  }
  return {
    enabled: true,
    primary: foreground(PALETTE.primary),
    muted: foreground(PALETTE.fgMuted),
    success: foreground(PALETTE.success),
    warning: foreground(PALETTE.warning),
    error: foreground(PALETTE.error),
    bold: wrap(ANSI_BOLD),
    dim: wrap(ANSI_DIM)
  }
}

function foreground(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  return wrap(`\x1b[38;2;${r};${g};${b}m`)
}

function wrap(open: string) {
  return function style(text: string) {
    return `${open}${text}${ANSI_RESET}`
  }
}

function hexToRgb(hex: string) {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  if (value.length !== HEX_COLOR_LENGTH) {
    throw new Error(`Expected a 6-digit hex color, got: ${hex}`)
  }
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return { r, g, b }
}

// Only the SGR sequences this module ever emits (`wrap` above) need
// stripping -- narrower than a general-purpose ANSI-regex library, but this
// file is the only producer of the escape codes the render layer has to
// measure and clip around.
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string) {
  return text.replace(ANSI_SGR_PATTERN, '')
}

/**
 * Every string this UI renders that did not originate here -- a session title,
 * a prompt, a tool summary, an approval detail line -- reached us through a
 * replicated journal any admitted peer can write. A carriage return lets such a
 * peer overwrite a row this process already drew, and a CSI or OSC sequence lets
 * it clear the screen or retitle the window from inside the approval prompt the
 * user is about to answer. Neither is theoretical: both are one JSON string
 * away. Strip anything that can move the cursor or change terminal state, and
 * keep only the tab, which the wrapper measures.
 */
export function sanitizeTerminalText(text: string) {
  let sanitized = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint === 0x09) {
      sanitized += ' '
      continue
    }
    // C0 controls, DEL, and the C1 range that doubles as 8-bit escapes.
    if (codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      continue
    }
    sanitized += char
  }
  return sanitized
}

// Counts display columns, not UTF-16 code units: ANSI escapes cost zero
// columns and a wide/CJK codepoint costs two, or box-drawn borders would
// drift out of alignment the moment non-Latin text entered a line.
export function visibleWidth(text: string) {
  const plain = stripAnsi(text)
  let width = 0
  for (const char of plain) {
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
  }
  return width
}

// Approximates the Unicode East Asian Width property's Wide/Fullwidth
// ranges. Not a complete implementation of the Unicode width tables, but
// enough to keep common CJK text from silently corrupting a box border.
function isWideCodePoint(codePoint: number) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

// Shared by this module's ambient `theme` export and by the driver
// (tui.ts), which derives color-enablement for an *injected* stdout port
// rather than the ambient `process.stdout` -- one rule, two callers, so the
// NO_COLOR/TERM checks cannot drift between them.
export function isColorEnabledFor(isTTY: boolean | undefined) {
  if (process.env.NO_COLOR != null) return false
  if (process.env.TERM === NO_COLOR_TERM) return false
  return isTTY === true
}

// The one impure export in this module: a ready-to-use theme for the
// driver, built from the ambient environment at import time. Everything
// else in this file, and all of tui-render.ts, stays pure.
export const theme = createTheme({ enabled: isColorEnabledFor(process.stdout.isTTY) })
