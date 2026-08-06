import { describe, expect, test } from 'bun:test'
import type { CodeApprovalDecision, CodeTranscriptBlock, CodeTurnView } from '@qvac-poc/qvac-code-shared'
import { createTheme, visibleWidth, type Theme } from '../lib/tui-theme.ts'
import {
  renderApproval,
  renderHeader,
  renderScreen,
  renderSessions,
  renderStatusLine,
  renderTranscript,
  type ApprovalModel,
  type HeaderModel,
  type ScreenModel,
  type SessionRowModel
} from '../lib/tui-render.ts'

// Color disabled: assertions read plain text, exactly as a NO_COLOR/dumb
// terminal or a piped demo would see it.
const plainTheme = createTheme({ enabled: false })

// Tags its input instead of coloring it, so which theme function a status
// or verdict maps to is observable in plain-text assertions without parsing
// ANSI escapes.
function tagFn(tag: string) {
  return function style(text: string) {
    return `[${tag}]${text}[/${tag}]`
  }
}

const tagTheme: Theme = {
  enabled: true,
  primary: tagFn('p'),
  muted: tagFn('m'),
  success: tagFn('s'),
  warning: tagFn('w'),
  error: tagFn('e'),
  bold: tagFn('b'),
  dim: tagFn('d')
}

function makeHeader(overrides: Partial<HeaderModel> = {}): HeaderModel {
  return {
    projectLabel: 'Fixture Project',
    projectRoot: '/home/user/fixture-project',
    executorId: 'executor-a',
    model: 'qvac-mini',
    pairing: { kind: 'offline' },
    skills: [],
    ...overrides
  }
}

function makeSession(overrides: Partial<SessionRowModel> = {}): SessionRowModel {
  return {
    sessionId: 'session-1',
    title: 'Fix the header',
    turnCount: 1,
    status: 'queued',
    updatedAt: 0,
    selected: false,
    ...overrides
  }
}

function makeTurn(overrides: Partial<CodeTurnView> = {}): CodeTurnView {
  return {
    turnWorkId: 'code/session-1/turn/1',
    sessionId: 'session-1',
    seq: 1,
    prompt: 'do the thing',
    status: 'running',
    claimedBy: 'executor-a',
    blocks: [],
    openApproval: null,
    finalText: null,
    truncated: false,
    updatedAt: 0,
    ...overrides
  }
}

function makeApprovalDecision(overrides: Partial<CodeApprovalDecision> = {}): CodeApprovalDecision {
  return {
    verdict: 'approved',
    decidedBy: { kind: 'executor', executorId: 'executor-a' },
    ...overrides
  }
}

describe('renderHeader', function () {
  test('shows the project label and the pairing state', function () {
    const lines = renderHeader(
      makeHeader({ pairing: { kind: 'paired', devices: ['device-a', 'device-b'] } }),
      plainTheme,
      60
    )
    const text = lines.join('\n')
    expect(text).toContain('Fixture Project')
    expect(text).toContain('paired')
    expect(text).toContain('2 devices')
  })

  test('prints an unpaired invite URI unwrapped and unmodified even far past width', function () {
    const inviteUri =
      'qvac-poc://pair?token=abcdefghijklmnopqrstuvwxyz0123456789&device=desktop&nonce=0011223344556677889900'
    const lines = renderHeader(makeHeader({ pairing: { kind: 'unpaired', inviteUri } }), plainTheme, 20)
    // The URI is its own line, byte-for-byte, never split across lines and
    // never clipped to `width` -- it is the string the user pastes.
    expect(lines.at(-1)).toBe(inviteUri)
    expect(lines.filter((line) => line.includes(inviteUri))).toHaveLength(1)
  })
})

describe('renderSessions', function () {
  test('marks the selected row and keeps every row at the same indent', function () {
    const lines = renderSessions(
      [
        makeSession({ sessionId: 's1', title: 'Alpha', selected: false }),
        makeSession({ sessionId: 's2', title: 'Beta', selected: true })
      ],
      plainTheme,
      80,
      0
    )
    expect(lines[0]?.startsWith('  Alpha')).toBe(true)
    expect(lines[1]?.startsWith('▸ Beta')).toBe(true)
    // Both markers occupy the same two columns, so the title starts at the
    // same offset whether or not the row is selected.
    expect(lines[0]?.slice(2).startsWith('Alpha')).toBe(true)
    expect(lines[1]?.slice(2).startsWith('Beta')).toBe(true)
  })

  test('shows a dim hint instead of throwing on an empty session list', function () {
    const lines = renderSessions([], plainTheme, 80, 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('phone')
  })

  test('maps each status word to its documented color function', function () {
    const statuses: ReadonlyArray<readonly [SessionRowModel['status'], string]> = [
      ['queued', '[m]queued[/m]'],
      ['claimed', '[p]claimed[/p]'],
      ['running', '[p]running[/p]'],
      ['awaiting-approval', '[w]awaiting-approval[/w]'],
      ['completed', '[s]completed[/s]'],
      ['failed', '[e]failed[/e]'],
      ['cancelled', '[e]cancelled[/e]'],
      ['idle', '[m]idle[/m]']
    ]
    for (const [status, expectedTag] of statuses) {
      const [line] = renderSessions([makeSession({ status })], tagTheme, 80, 0)
      expect(line).toContain(expectedTag)
    }
  })
})

describe('renderTranscript', function () {
  test('wraps assistant text on a word boundary', function () {
    const block: CodeTranscriptBlock = { kind: 'assistant', text: 'aaaa bbbb cccc' }
    const lines = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 9, 0)
    expect(lines).toEqual(['aaaa bbbb', 'cccc'])
  })

  test('collapses a long thinking block to 3 lines plus a more-lines marker', function () {
    const block: CodeTranscriptBlock = {
      kind: 'thinking',
      text: 'one\ntwo\nthree\nfour\nfive'
    }
    const lines = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 20, 0)
    expect(lines).toEqual(['one', 'two', 'three', '… 2 more lines'])
  })

  test('shows a trailing ellipsis for a pending tool call', function () {
    const block: CodeTranscriptBlock = {
      kind: 'tool',
      callRef: 'call-1',
      name: 'read',
      request: 'file.ts',
      outcome: null
    }
    const [line] = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 80, 0)
    expect(line).toContain('read')
    expect(line).toContain('file.ts')
    expect(line?.endsWith('…')).toBe(true)
  })

  test('shows a completed tool call outcome on the same line when it fits', function () {
    const block: CodeTranscriptBlock = {
      kind: 'tool',
      callRef: 'call-1',
      name: 'read',
      request: 'file.ts',
      outcome: { ok: true, summary: '42 lines' }
    }
    const lines = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 80, 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read')
    expect(lines[0]).toContain('file.ts')
    expect(lines[0]).toContain('42 lines')
  })

  test('prefixes an error block with the ✖ glyph', function () {
    const block: CodeTranscriptBlock = { kind: 'error', message: 'boom' }
    const [line] = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 80, 0)
    expect(line?.startsWith('✖ ')).toBe(true)
    expect(line).toContain('boom')
  })

  test('renders a withdrawn approval verdict as "withdrawn", never "denied"', function () {
    const block: CodeTranscriptBlock = {
      kind: 'approval',
      gateId: 'approval/executor-a/1',
      name: 'shell',
      summary: 'run rm -rf build',
      detail: ['cwd: /tmp'],
      decision: makeApprovalDecision({ verdict: 'withdrawn', decidedBy: { kind: 'policy', rule: 'run-ended' } }),
      stale: false
    }
    const text = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 60, 0).join('\n')
    expect(text).toContain('withdrawn')
    expect(text).not.toContain('denied')
  })

  test('renders an unanswered approval verdict as "unanswered", never "denied"', function () {
    const block: CodeTranscriptBlock = {
      kind: 'approval',
      gateId: 'approval/executor-a/1',
      name: 'shell',
      summary: 'run rm -rf build',
      detail: [],
      decision: makeApprovalDecision({ verdict: 'unanswered', decidedBy: { kind: 'policy', rule: 'deadline' } }),
      stale: false
    }
    const text = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 60, 0).join('\n')
    expect(text).toContain('unanswered')
    expect(text).not.toContain('denied')
  })

  test('adds a dim note when a resolved approval is stale', function () {
    const block: CodeTranscriptBlock = {
      kind: 'approval',
      gateId: 'approval/executor-a/1',
      name: 'shell',
      summary: 'run tests',
      detail: [],
      decision: makeApprovalDecision({ verdict: 'approved' }),
      stale: true
    }
    const text = renderTranscript(makeTurn({ blocks: [block] }), plainTheme, 60, 0).join('\n')
    expect(text).toContain('already finished')
  })

  test('does not throw on a turn with no blocks', function () {
    expect(() => renderTranscript(makeTurn({ blocks: [] }), plainTheme, 60, 0)).not.toThrow()
    expect(renderTranscript(makeTurn({ blocks: [] }), plainTheme, 60, 0)).toEqual([])
  })

  test('does not throw when there is no turn at all', function () {
    expect(() => renderTranscript(null, plainTheme, 60, 0)).not.toThrow()
    expect(renderTranscript(null, plainTheme, 60, 0)).toEqual([])
  })
})

describe('renderApproval', function () {
  test('shows an awaiting-decision prompt when nothing has been decided yet', function () {
    const model: ApprovalModel = {
      toolName: 'shell',
      summary: 'run the test suite',
      detail: ['command: bun test'],
      decidedBy: null,
      verdict: null
    }
    const text = renderApproval(model, plainTheme, 60).join('\n')
    expect(text).toContain('awaiting decision')
    expect(text).toContain('run the test suite')
  })
})

describe('renderStatusLine', function () {
  test('prefixes the status glyph', function () {
    expect(renderStatusLine('connected to peer', plainTheme)).toContain('▸ connected to peer')
  })
})

describe('renderScreen', function () {
  function makeScreen(overrides: Partial<ScreenModel> = {}): ScreenModel {
    return {
      header: makeHeader({ pairing: { kind: 'paired', devices: ['device-a'] } }),
      sessions: [makeSession()],
      turn: null,
      approval: null,
      notices: [],
      width: 40,
      height: 20,
      now: 0,
      ...overrides
    }
  }

  test('never emits a line wider than width', function () {
    const longBlock: CodeTranscriptBlock = {
      kind: 'assistant',
      text: 'a very long sentence that will need to be wrapped across several lines of the transcript pane'
    }
    const screen = makeScreen({
      sessions: [makeSession({ title: 'A session title long enough to need clipping against a narrow terminal' })],
      turn: makeTurn({ blocks: [longBlock] }),
      notices: ['a notice that is also long enough to possibly overflow the configured width'],
      width: 30,
      height: 15
    })
    const lines = renderScreen(screen, plainTheme)
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30)
    }
  })

  test('clips to height by dropping the oldest transcript lines while keeping the approval block', function () {
    const blocks: CodeTranscriptBlock[] = []
    for (let index = 1; index <= 20; index++) {
      blocks.push({ kind: 'assistant', text: `line-${index}` })
    }
    const approval: ApprovalModel = {
      toolName: 'shell',
      summary: 'run a distinctive marker command',
      detail: [],
      decidedBy: null,
      verdict: null
    }
    const screen = makeScreen({
      turn: makeTurn({ blocks }),
      approval,
      sessions: [],
      width: 40,
      height: 12
    })
    const lines = renderScreen(screen, plainTheme)
    const text = lines.join('\n')
    expect(text).toContain('line-20')
    expect(text).not.toContain('line-1\n')
    expect(text).toContain('distinctive marker command')
  })

  test('does not throw on degenerate width and height', function () {
    for (const width of [0, 1, 5, 19]) {
      for (const height of [0, 1, 3, 5]) {
        expect(() => renderScreen(makeScreen({ width, height }), plainTheme)).not.toThrow()
      }
    }
  })

  test('does not throw with an empty session list', function () {
    expect(() => renderScreen(makeScreen({ sessions: [] }), plainTheme)).not.toThrow()
  })
})

describe('renderScreen honours height at any terminal size', function () {
  const plain = createTheme({ enabled: false })

  function screenAt(height: number) {
    return renderScreen(
      {
        header: {
          projectLabel: 'demo',
          projectRoot: '/repo/demo',
          executorId: 'code-mac-abc',
          model: 'Qwen3.5-9B',
          pairing: { kind: 'paired', devices: ['iPhone'] },
          skills: ['qvac-code']
        },
        sessions: [
          { sessionId: 's1', title: 't', turnCount: 1, status: 'running', updatedAt: 0, selected: true }
        ],
        turn: {
          turnWorkId: 'w',
          sessionId: 's1',
          seq: 0,
          prompt: 'p',
          status: 'awaiting-approval',
          claimedBy: 'code-mac-abc',
          blocks: Array.from({ length: 40 }, (_, index) => ({
            kind: 'assistant' as const,
            text: `line ${index}`
          })),
          openApproval: null,
          finalText: null,
          truncated: false,
          updatedAt: 0
        },
        approval: {
          toolName: 'shell',
          summary: 'shell bun test',
          detail: ['command: bun test'],
          decidedBy: null,
          verdict: null
        },
        notices: [],
        width: 80,
        height,
        now: 0
      },
      plain
    )
  }

  /**
   * The header and session rows alone can exceed a very short terminal, so
   * dropping transcript lines is not enough on its own.
   */
  test('clips the whole frame when the fixed rows already overflow', function () {
    for (const height of [6, 7, 8, 12, 24]) {
      expect(screenAt(height).length).toBeLessThanOrEqual(height)
    }
  })

  test('keeps the approval prompt visible in a very short terminal', function () {
    expect(screenAt(6).join('\n')).toContain('bun test')
  })
})
