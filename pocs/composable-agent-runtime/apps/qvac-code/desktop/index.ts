import { access, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createAssistant, type AssistantFacade } from '@qvac/assistant'
import {
  CODE_EXECUTOR_CAPABILITY,
  createSessionId,
  formatTurnWorkId,
  projectSessionList,
  projectTurn,
  type CodeTurnView
} from '@qvac-poc/qvac-code-shared'
import { createCodeMeshStore, type CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'
import { CODING_SKILL_NAME, CODING_TOOL_NAMES } from './lib/skills-impl/coding/names.ts'
import { resolveExecutorIdentity } from './lib/executor-identity.ts'
import { createTurnRunner } from './lib/turn-runner.ts'
import { createApprovalBridge } from './lib/approval-bridge.ts'
import { createExecutor } from './lib/executor.ts'
import { createTui } from './lib/tui.ts'
import { resolveBareExecutable } from './lib/bare-executable.ts'

const DEFAULT_MODEL =
  'registry://hf/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf'
const DEFAULT_STORAGE = '.qvac-code'
const DEFAULT_APPROVAL_DEADLINE_MS = 10 * 60_000
const INVITE_LIFETIME_MS = 30 * 60_000
const SESSION_REFRESH_MS = 1_000
const MAX_READ_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024
const SHELL_TIMEOUT_MS = 120_000

type Command =
  | {
      readonly mode: 'serve'
      readonly projectRoot: string
      readonly storagePath: string
      readonly model: string
      readonly bareExecutable: string | undefined
      readonly approvalDeadlineMs: number
      readonly allowSecondExecutor: boolean
    }
  | {
      readonly mode: 'once'
      readonly projectRoot: string
      readonly storagePath: string
      readonly model: string
      readonly bareExecutable: string | undefined
      readonly approvalDeadlineMs: number
      readonly prompt: string
    }

export function parseCommand(args: readonly string[]): Command {
  const mode = args[0]
  if (mode !== 'serve' && mode !== 'once') {
    throw new Error(
      'Usage: qvac-code <serve|once> --project <path> [--storage <path>] [--model <ref>] [--bare <path>] [--approval-deadline <ms>] [--allow-second-executor] [--prompt <text>]'
    )
  }
  const projectRoot = option(args, '--project')
  if (!projectRoot) throw new Error('--project is required')
  const shared = {
    projectRoot,
    storagePath: option(args, '--storage') ?? DEFAULT_STORAGE,
    model: option(args, '--model') ?? DEFAULT_MODEL,
    bareExecutable: option(args, '--bare'),
    approvalDeadlineMs: parseDeadline(option(args, '--approval-deadline'))
  }
  if (mode === 'once') {
    const prompt = option(args, '--prompt')
    if (!prompt) throw new Error('once requires --prompt')
    return { mode, ...shared, prompt }
  }
  return {
    mode,
    ...shared,
    allowSecondExecutor: args.includes('--allow-second-executor')
  }
}

export async function runCommand(command: Command): Promise<void> {
  const projectRoot = await requireDirectory(command.projectRoot)
  const identity = await resolveExecutorIdentity({ projectRoot, hostname: hostname() })
  const bareExecutable = await resolveBareExecutable(command.bareExecutable)

  // `once` stays off the network: it exists to exercise the skill and the claim
  // loop without a phone, and an empty bootstrap list keeps Sync from looking
  // for peers it will never find.
  const assistant = createAssistant({
    storagePath: command.storagePath,
    sync: command.mode === 'once' ? { bootstrap: [] } : {},
    logging: { level: 'off' },
    inference: { kind: 'qwen' },
    workers: {
      harnessChildEntry: new URL('./harness-child-entry.ts', import.meta.url).href,
      toolSandboxChildEntry: new URL('./tool-sandbox-child-entry.ts', import.meta.url).href
    },
    host: {
      platform: process.platform,
      bareExecutable,
      skills: {
        [CODING_SKILL_NAME]: {
          projectRoot: identity.projectRoot,
          projectLabel: identity.projectLabel,
          maxReadBytes: MAX_READ_BYTES,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          shellTimeoutMs: SHELL_TIMEOUT_MS
        }
      }
    }
  })

  const controller = new AbortController()
  const removeSignalHandlers = installShutdownHandlers(controller)
  try {
    await assistant.ready()
    const store = createCodeMeshStore({ work: assistant.state.work })
    if (command.mode === 'once') {
      await runOnce({ assistant, store, identity, command, signal: controller.signal })
      return
    }
    await runServe({ assistant, store, identity, command, signal: controller.signal })
  } finally {
    controller.abort('qvac-code stopped')
    removeSignalHandlers()
    await assistant.close().catch(() => {})
  }
}

interface RuntimeContext {
  readonly assistant: AssistantFacade
  readonly store: CodeMeshStore
  readonly identity: Awaited<ReturnType<typeof resolveExecutorIdentity>>
  readonly signal: AbortSignal
}

async function runServe(
  input: RuntimeContext & { readonly command: Extract<Command, { mode: 'serve' }> }
) {
  const { assistant, store, identity, command, signal } = input
  const tui = createTui({ stdout: process.stdout, stdin: process.stdin, now: () => Date.now() })
  try {
    const approvals = createApprovalBridge({
      store,
      assistant,
      executorId: identity.executorId,
      now: () => Date.now(),
      approvalDeadlineMs: command.approvalDeadlineMs,
      promptLocally: (prompt, promptSignal) =>
        tui.promptApproval(
          { toolName: prompt.toolName, summary: prompt.summary, detail: prompt.detail },
          promptSignal
        ),
      onResolved: ({ prompt, decision }) => {
        tui.notice(
          `approval ${prompt.toolName}: ${decision.verdict} (${describeDecider(decision.decidedBy)})`
        )
      }
    })
    const executor = createExecutor({
      store,
      assistant,
      identity,
      model: command.model,
      turnRunner: createTurnRunner({
        store,
        assistant,
        executorId: identity.executorId,
        now: () => Date.now(),
        onEvent: (event) => {
          if (event.kind === 'error') tui.error(event.message)
        }
      }),
      approvals,
      now: () => Date.now(),
      sleep: (ms) => sleep(ms, signal),
      allowSecondExecutor: command.allowSecondExecutor,
      onEvent: (event) => {
        tui.notice(`${event.kind}${event.detail ? `: ${event.detail}` : ''}`)
      }
    })

    await executor.preflight()
    await executor.recoverOrphans()
    await approvals.reconcile()

    const invite = await assistant.state.mesh.createInvite({
      expiresInMs: INVITE_LIFETIME_MS
    })
    const skills = await assistant.listSkills()
    tui.update({
      header: {
        projectLabel: identity.projectLabel,
        projectRoot: identity.projectRoot,
        executorId: identity.executorId,
        model: shortModelName(command.model),
        pairing: { kind: 'unpaired', inviteUri: formatPairingUri(invite) },
        skills: skills.map((skill) => skill.name)
      }
    })

    await Promise.all([
      approvePairingCandidates(assistant, tui, signal),
      refreshScreen({
        assistant,
        store,
        identity,
        command,
        tui,
        signal,
        inviteUri: formatPairingUri(invite)
      }),
      approvals.start(signal),
      executor.run(signal)
    ])
  } finally {
    tui.close()
  }
}

async function runOnce(
  input: RuntimeContext & { readonly command: Extract<Command, { mode: 'once' }> }
) {
  const { assistant, store, identity, command, signal } = input
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const approvals = createApprovalBridge({
      store,
      assistant,
      executorId: identity.executorId,
      now: () => Date.now(),
      approvalDeadlineMs: command.approvalDeadlineMs,
      async promptLocally(prompt, promptSignal) {
        console.log(`▸ approve ${prompt.toolName}: ${prompt.summary}`)
        for (const line of prompt.detail) console.log(`▸   ${line}`)
        const answer = await terminal.question('▸ allow? [y/n] ', {
          signal: promptSignal
        })
        return answer.trim().toLowerCase() === 'y'
      },
      onResolved: ({ prompt, decision }) => {
        console.log(`▸ approval ${prompt.toolName}: ${decision.verdict}`)
      }
    })
    const executor = createExecutor({
      store,
      assistant,
      identity,
      model: command.model,
      turnRunner: createTurnRunner({
        store,
        assistant,
        executorId: identity.executorId,
        now: () => Date.now(),
        onEvent: (event) => {
          if (event.kind === 'content') process.stdout.write(event.text)
          else if (event.kind === 'tool-call') console.log(`\n▸ ${event.summary}`)
          else if (event.kind === 'error') console.error(`✖ ${event.message}`)
        }
      }),
      approvals,
      now: () => Date.now(),
      sleep: (ms) => sleep(ms, signal),
      allowSecondExecutor: true,
      onEvent: (event) => {
        if (event.kind === 'error') console.error(`✖ ${event.detail ?? event.kind}`)
      }
    })
    await executor.recoverOrphans()

    const sessionId = createSessionId(`${identity.executorId}:${Date.now()}`)
    console.log(`▸ session ${sessionId} in ${identity.projectLabel}`)
    await store.createSession({
      sessionId,
      title: firstLine(command.prompt),
      projectLabel: identity.projectLabel,
      model: command.model,
      createdBy: identity.executorId
    })
    const created = await store.createTurn({
      sessionId,
      seq: 0,
      prompt: command.prompt,
      requestedBy: identity.executorId,
      target: identity.executorId
    })
    const turnWorkId = formatTurnWorkId({ sessionId, seq: 0 })

    const finished = new AbortController()
    await Promise.race([
      Promise.all([approvals.start(finished.signal), executor.run(finished.signal)]),
      waitForOutcome(store, turnWorkId, signal).then(() => finished.abort('turn finished'))
    ])
    finished.abort('turn finished')

    const view = await readTurnView(store, turnWorkId)
    console.log()
    if (view?.finalText) console.log(view.finalText)
    console.log(`▸ ${created.kind} · ${view?.status ?? 'unknown'}`)
    if (view?.status === 'failed') process.exitCode = 1
  } finally {
    terminal.close()
  }
}

async function refreshScreen(input: {
  readonly assistant: AssistantFacade
  readonly store: CodeMeshStore
  readonly identity: Awaited<ReturnType<typeof resolveExecutorIdentity>>
  readonly command: Extract<Command, { mode: 'serve' }>
  readonly tui: ReturnType<typeof createTui>
  readonly signal: AbortSignal
  readonly inviteUri: string
}) {
  const { assistant, store, identity, command, tui, signal, inviteUri } = input
  while (!signal.aborted) {
    try {
      const [devices, sessions] = await Promise.all([
        assistant.state.mesh.listDevices(),
        store.listSessions()
      ])
      const summaries = projectSessionList(sessions)
      const newest = summaries.at(0)
      const turn = newest ? await newestTurnView(store, newest.sessionId) : null
      tui.update({
        header: {
          projectLabel: identity.projectLabel,
          projectRoot: identity.projectRoot,
          executorId: identity.executorId,
          model: shortModelName(command.model),
          // Keep showing the invite until a second device is in the mesh: this
          // process is itself a device, so one is "nobody paired yet".
          pairing:
            devices.length > 1
              ? { kind: 'paired', devices: devices.map((device) => device.name ?? 'device') }
              : { kind: 'unpaired', inviteUri },
          skills: [CODING_SKILL_NAME]
        },
        sessions: summaries.map((summary, index) => ({
          sessionId: summary.sessionId,
          title: summary.title,
          // Only the selected session's turn is fetched, so the others report
          // their own row rather than an inaccurate count.
          turnCount: index === 0 ? (turn ? turn.seq + 1 : 0) : 0,
          status: index === 0 ? (turn?.status ?? 'idle') : 'idle',
          updatedAt: index === 0 ? (turn?.updatedAt ?? summary.createdAt) : summary.createdAt,
          selected: index === 0
        })),
        turn,
        now: Date.now()
      })
    } catch (error) {
      // A refresh failure is cosmetic: the executor keeps working and the next
      // pass repaints. Surfacing it as a notice beats stopping the loop.
      tui.notice(`screen refresh failed: ${errorMessage(error)}`)
    }
    await sleep(SESSION_REFRESH_MS, signal)
  }
}

async function newestTurnView(store: CodeMeshStore, sessionId: string) {
  const seq = (await store.nextTurnSeq(sessionId)) - 1
  if (seq < 0) return null
  return readTurnView(store, formatTurnWorkId({ sessionId, seq }))
}

async function readTurnView(
  store: CodeMeshStore,
  turnWorkId: string
): Promise<CodeTurnView | null> {
  const [work, entries, gates] = await Promise.all([
    store.getWork(turnWorkId),
    store.listJournal(turnWorkId),
    store.listGates(turnWorkId)
  ])
  if (!work) return null
  return projectTurn({ work, entries, gates })
}

async function waitForOutcome(store: CodeMeshStore, turnWorkId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const work = await store.getWork(turnWorkId)
    if (work?.outcomeStatus != null) return
    await sleep(250, signal)
  }
}

async function approvePairingCandidates(
  assistant: AssistantFacade,
  tui: ReturnType<typeof createTui>,
  signal: AbortSignal
) {
  const handled = new Set<string>()
  const iterator = assistant.state.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const next = await nextUntilAbort(iterator, signal)
      if (next.done) return
      for (const request of next.value.requests) {
        const id = request.id.toString('hex')
        if (request.status !== 'pending' || handled.has(id)) continue
        handled.add(id)
        const approved = await tui.confirm(
          `pair writer ${request.fingerprint}? [y/n]`,
          signal
        )
        if (signal.aborted) return
        if (approved) {
          await assistant.state.mesh.approvePairingRequest(request.id)
          tui.notice(`paired ${request.fingerprint}`)
        } else {
          await assistant.state.mesh.rejectPairingRequest(request.id)
          tui.notice(`rejected ${request.fingerprint}`)
        }
      }
    }
  } finally {
    // A pending HRPC iterator.next() cannot be cancelled by iterator.return().
    // Assistant shutdown closes the transport after the abort.
    if (!signal.aborted) await iterator.return?.()
  }
}

export function formatPairingUri(invite: {
  readonly invite: Buffer
  readonly expiresAt: number
}) {
  const encoded = invite.invite.toString('base64url')
  return `qvac-poc://pair?invite=${encoded}&expiresAt=${invite.expiresAt}`
}

export function describeDecider(decidedBy: {
  readonly kind: string
  readonly executorId?: string
  readonly deviceRef?: string
  readonly rule?: string
}) {
  if (decidedBy.kind === 'executor') return `this machine`
  if (decidedBy.kind === 'peer') return `peer ${decidedBy.deviceRef ?? ''}`.trim()
  return `policy ${decidedBy.rule ?? ''}`.trim()
}

export function shortModelName(model: string) {
  const tail = model.split('/').at(-1) ?? model
  return tail.replace(/\.gguf$/, '')
}

export const CODING_AGENT_TOOL_POLICY = {
  allow: [...CODING_TOOL_NAMES],
  requireApproval: ['write', 'edit', 'shell']
} as const

export const CODING_AGENT_CAPABILITY = CODE_EXECUTOR_CAPABILITY

function firstLine(text: string) {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || 'Untitled session'
}

function option(args: readonly string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function parseDeadline(value: string | undefined) {
  if (value === undefined) return DEFAULT_APPROVAL_DEADLINE_MS
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error('--approval-deadline must be at least 1000 milliseconds')
  }
  return parsed
}

async function requireDirectory(candidate: string) {
  const resolved = await realpath(candidate).catch(() => {
    throw new Error(`--project must be an existing directory: ${candidate}`)
  })
  await access(join(resolved, '.')).catch(() => {
    throw new Error(`--project is not readable: ${resolved}`)
  })
  return resolved
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function nextUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined }
  let onAbort = () => {}
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function installShutdownHandlers(controller: AbortController) {
  function onSigint() {
    controller.abort('qvac-code stopped by SIGINT')
  }
  function onSigterm() {
    controller.abort('qvac-code stopped by SIGTERM')
  }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return function removeSignalHandlers() {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const isMain =
  import.meta.main === true || process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    await runCommand(parseCommand(process.argv.slice(2)))
  } catch (error) {
    console.error(`✖ ${errorMessage(error)}`)
    process.exitCode = 1
  }
}
