import Buffer from '#buffer'
import fs from '#fs-promises'
import path from '#path'
import process from '#process'
import type {
  HarnessJsonValue,
  SkillSandboxProvider,
  ToolSandboxExecutionRequest
} from '@qvac/harness/skill-sandbox'
import { applyEdit } from './edit.ts'
import { compileGlob } from './glob-match.ts'
import { resolveAllowedCommand, type AllowedCommand } from './shell-allowlist.ts'
import { isVersionControlInternal, resolveProjectPath } from './paths.ts'
import { CODING_SKILL_NAME, CODING_TOOL_NAMES } from './names.ts'
import {
  CODING_TOOL_EDIT,
  CODING_TOOL_GLOB,
  CODING_TOOL_GREP,
  CODING_TOOL_LS,
  CODING_TOOL_READ,
  CODING_TOOL_SHELL,
  CODING_TOOL_WRITE
} from './names.ts'

export { CODING_SKILL_NAME } from './names.ts'

const DEFAULT_READ_LIMIT = 2_000
const BINARY_SAMPLE_BYTES = 4_096
const MAX_READABLE_FILE_BYTES = 10 * 1_024 * 1_024
const GLOB_MAX_RESULTS = 200
const GLOB_MAX_DEPTH = 12
const GREP_MAX_MATCHES = 100
const GREP_MAX_PATTERN_LENGTH = 200
const GREP_MAX_FILE_BYTES = 512 * 1_024
const GREP_MAX_MATCH_TEXT_BYTES = 2_000
const LS_MAX_ENTRIES = 500
const TERMINATION_GRACE_MS = 250
const TRUNCATED_SUFFIX = '… [truncated]'
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'build'])

export interface CodingSandboxConfiguration {
  readonly projectRoot: string
  readonly projectLabel: string
  readonly maxReadBytes: number
  readonly maxOutputBytes: number
  readonly shellTimeoutMs: number
}

interface CodingChildStream {
  on(event: 'data', listener: (chunk: unknown) => void): object
}

interface CodingChild {
  readonly stdout: CodingChildStream | null
  readonly stderr: CodingChildStream | null
  once(
    event: string,
    listener: (...args: readonly (number | string | null | Error)[]) => void
  ): object
  kill(signal?: number | string): void
}

interface CodingSpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly shell: false
  readonly detached: false
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
}

export type CodingSpawn = (
  file: string,
  argv: readonly string[],
  options: CodingSpawnOptions
) => CodingChild

export interface CodingSandboxRuntime {
  readonly spawn?: CodingSpawn
}

/**
 * The in-sandbox half of the qvac-code skill: seven filesystem/shell tools
 * scoped to one project. `runtime` is an injection seam so unit tests can
 * supply a fake `spawn` and never touch a real subprocess.
 */
export function createCodingSkillSandbox(
  runtime: CodingSandboxRuntime = {}
): SkillSandboxProvider {
  return {
    name: CODING_SKILL_NAME,
    tools: [...CODING_TOOL_NAMES],
    create({ configuration }) {
      const coding = parseConfiguration(configuration)
      // Absolute paths read (or written) in this sandbox's lifetime, used to
      // enforce read-before-edit. Deliberately per-sandbox, in memory only:
      // a fresh sandbox process legitimately requires re-reading a file, and
      // that is fine because the sandbox is short-lived and per-agent.
      const readFiles = new Set<string>()
      // Redundant with the wire's own per-invocation abort-on-close (see
      // ../../../../../packages/harness/lib/tool-sandbox/wire.ts
      // closeServer), which already aborts every active invocation's signal
      // before awaiting this executor's close(). Tracked here too, mirroring
      // the obsidian skill's desktop-executor.ts, so a spawned child is
      // still terminated even if this executor is ever driven outside that
      // wire (e.g. directly, as the tests here do).
      const activeShellCommands = new Set<RunningShellCommand>()
      let closed = false
      return {
        async invoke(request) {
          if (closed) throw new Error('qvac-code sandbox executor is closed')
          return dispatch(coding, readFiles, request, runtime, activeShellCommands)
        },
        async close() {
          if (closed) return
          closed = true
          const running = [...activeShellCommands]
          for (const command of running) command.terminate()
          await Promise.allSettled(running.map((command) => command.result))
        }
      }
    }
  }
}

async function dispatch(
  coding: CodingSandboxConfiguration,
  readFiles: Set<string>,
  request: ToolSandboxExecutionRequest,
  runtime: CodingSandboxRuntime,
  activeShellCommands: Set<RunningShellCommand>
): Promise<HarnessJsonValue> {
  switch (request.toolName) {
    case CODING_TOOL_READ:
      return executeRead(coding, readFiles, request.input)
    case CODING_TOOL_WRITE:
      return executeWrite(coding, readFiles, request.input)
    case CODING_TOOL_EDIT:
      return executeEdit(coding, readFiles, request.input)
    case CODING_TOOL_GLOB:
      return executeGlob(coding, request.input)
    case CODING_TOOL_GREP:
      return executeGrep(coding, request.input)
    case CODING_TOOL_LS:
      return executeLs(coding, request.input)
    case CODING_TOOL_SHELL:
      return executeShell(coding, request.input, request.signal, runtime, activeShellCommands)
    default:
      throw new Error(`qvac-code sandbox tool is not registered: ${request.toolName}`)
  }
}

function parseConfiguration(
  value: Readonly<Record<string, HarnessJsonValue>>
): CodingSandboxConfiguration {
  const projectRoot = value.projectRoot
  const projectLabel = value.projectLabel
  const maxReadBytes = value.maxReadBytes
  const maxOutputBytes = value.maxOutputBytes
  const shellTimeoutMs = value.shellTimeoutMs
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('qvac-code sandbox configuration requires an absolute projectRoot')
  }
  if (typeof projectLabel !== 'string') {
    throw new Error('qvac-code sandbox configuration requires a projectLabel')
  }
  // A safe-positive-integer check, not just typeof === 'number': NaN and
  // Infinity are both 'number', and a NaN limit silently disables every cap
  // that compares against it (`bytes > NaN` is always false).
  requirePositiveInteger(maxReadBytes, 'maxReadBytes')
  requirePositiveInteger(maxOutputBytes, 'maxOutputBytes')
  requirePositiveInteger(shellTimeoutMs, 'shellTimeoutMs')
  return { projectRoot, projectLabel, maxReadBytes, maxOutputBytes, shellTimeoutMs }
}

function requirePositiveInteger(
  value: HarnessJsonValue | undefined,
  label: string
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`qvac-code sandbox configuration ${label} must be a positive safe integer`)
  }
}

// --- shared path/argument helpers --------------------------------------

function requireString(input: Readonly<Record<string, HarnessJsonValue>>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`${key} is required and must be a string`)
  return value
}

function optionalPositiveInteger(
  input: Readonly<Record<string, HarnessJsonValue>>,
  key: string
): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`)
  }
  return value
}

function optionalBoolean(input: Readonly<Record<string, HarnessJsonValue>>, key: string): boolean {
  const value = input[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

// Independent of the host's validateCall in host.ts (see its comment):
// every tool re-resolves the path itself, because the sandbox is the
// boundary that cannot be bypassed.
function resolvePathOrThrow(coding: CodingSandboxConfiguration, requested: string) {
  const resolved = resolveProjectPath({ projectRoot: coding.projectRoot, requested })
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved
}

function relativeOf(coding: CodingSandboxConfiguration, absolute: string) {
  const relative = path.relative(coding.projectRoot, absolute)
  return relative === '' ? '.' : relative
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function humanError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

async function statOrThrow(absolute: string, relative: string) {
  try {
    return await fs.stat(absolute)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') throw new Error(`${relative || '.'} does not exist`)
    throw error
  }
}

async function pathExists(absolute: string) {
  try {
    await fs.stat(absolute)
    return true
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw error
  }
}

async function resolveSearchBase(
  coding: CodingSandboxConfiguration,
  requestedPath: HarnessJsonValue | undefined
) {
  if (requestedPath === undefined) return coding.projectRoot
  if (typeof requestedPath !== 'string') throw new Error('path must be a string')
  const resolved = resolvePathOrThrow(coding, requestedPath)
  const stat = await statOrThrow(resolved.absolute, resolved.relative)
  if (!stat.isDirectory()) {
    throw new Error(`${resolved.relative || '.'} is not a directory`)
  }
  return resolved.absolute
}

function truncateUtf8(text: string, limit: number, suffix: string) {
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  // If the suffix alone would not fit inside the limit, appending it would
  // break the very guarantee this function exists to provide, so drop it
  // and hard-truncate instead of overrunning the cap.
  const usableSuffix = suffixBytes < limit ? suffix : ''
  const budget = Math.max(0, limit - Buffer.byteLength(usableSuffix, 'utf8'))
  let result = ''
  let bytes = 0
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > budget) break
    result += character
    bytes += characterBytes
  }
  return `${result}${usableSuffix}`
}

// --- read ----------------------------------------------------------------

function looksBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES))
  return sample.includes(0)
}

// Independent of maxReadBytes, which bounds the *returned* excerpt after the
// whole file is already loaded and line-split. Without this, `read`/`edit`
// would buffer an arbitrarily large file into memory before that later
// check ever runs, so a huge file is refused up front instead.
function assertReadableSize(size: number, relative: string) {
  if (size > MAX_READABLE_FILE_BYTES) {
    throw new Error(
      `${relative || '.'} is ${size} bytes, over the ${MAX_READABLE_FILE_BYTES}-byte limit this tool can load into memory`
    )
  }
}

async function executeRead(
  coding: CodingSandboxConfiguration,
  readFiles: Set<string>,
  input: Readonly<Record<string, HarnessJsonValue>>
) {
  const filePath = requireString(input, 'filePath')
  const offset = optionalPositiveInteger(input, 'offset') ?? 1
  const limit = optionalPositiveInteger(input, 'limit') ?? DEFAULT_READ_LIMIT
  const resolved = resolvePathOrThrow(coding, filePath)
  const stat = await statOrThrow(resolved.absolute, resolved.relative)
  if (stat.isDirectory()) {
    throw new Error(`${resolved.relative || '.'} is a directory; use ls instead`)
  }
  assertReadableSize(stat.size, resolved.relative)

  const buffer = await fs.readFile(resolved.absolute)
  if (looksBinary(buffer)) {
    throw new Error(`${resolved.relative} looks like a binary file`)
  }

  const lines = buffer.toString('utf8').split('\n')
  const totalLines = lines.length
  const startIndex = offset - 1
  // >= , not >: startIndex === totalLines is one line past the last valid
  // line (offset === totalLines + 1). Letting that through produced an
  // empty, inverted range (lineStart > lineEnd) instead of a clear error.
  if (startIndex >= totalLines) {
    throw new Error(`offset ${offset} is beyond the end of the file (${totalLines} lines)`)
  }
  const selected = lines.slice(startIndex, startIndex + limit)
  const lineTruncated = startIndex + selected.length < totalLines
  const joined = selected.join('\n')
  const byteTruncated = Buffer.byteLength(joined, 'utf8') > coding.maxReadBytes
  const content = byteTruncated
    ? truncateUtf8(joined, coding.maxReadBytes, TRUNCATED_SUFFIX)
    : joined

  readFiles.add(resolved.absolute)
  return {
    path: resolved.relative,
    content,
    lineStart: offset,
    lineEnd: offset + selected.length - 1,
    totalLines,
    truncated: lineTruncated || byteTruncated
  }
}

// --- write -----------------------------------------------------------------

async function executeWrite(
  coding: CodingSandboxConfiguration,
  readFiles: Set<string>,
  input: Readonly<Record<string, HarnessJsonValue>>
) {
  const filePath = requireString(input, 'filePath')
  const content = requireString(input, 'content')
  const resolved = resolvePathOrThrow(coding, filePath)
  if (isVersionControlInternal(resolved.relative)) {
    throw new Error(`refusing to write ${resolved.relative}: .git is out of scope`)
  }
  const existed = await pathExists(resolved.absolute)
  if (existed && !readFiles.has(resolved.absolute)) {
    throw new Error(`${resolved.relative} must be read before it is overwritten; call read first`)
  }
  await fs.mkdir(path.dirname(resolved.absolute), { recursive: true })
  await fs.writeFile(resolved.absolute, content, 'utf8')
  readFiles.add(resolved.absolute)
  return {
    path: resolved.relative,
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed
  }
}

// --- edit --------------------------------------------------------------

async function executeEdit(
  coding: CodingSandboxConfiguration,
  readFiles: Set<string>,
  input: Readonly<Record<string, HarnessJsonValue>>
) {
  const filePath = requireString(input, 'filePath')
  const oldString = requireString(input, 'oldString')
  const newString = requireString(input, 'newString')
  const replaceAll = optionalBoolean(input, 'replaceAll')
  const resolved = resolvePathOrThrow(coding, filePath)
  if (isVersionControlInternal(resolved.relative)) {
    throw new Error(`refusing to edit ${resolved.relative}: .git is out of scope`)
  }
  if (!readFiles.has(resolved.absolute)) {
    throw new Error(`${resolved.relative} must be read before it is edited; call read first`)
  }
  const stat = await statOrThrow(resolved.absolute, resolved.relative)
  if (stat.isDirectory()) {
    throw new Error(`${resolved.relative} is a directory, not a file`)
  }
  assertReadableSize(stat.size, resolved.relative)
  const contents = await fs.readFile(resolved.absolute, 'utf8')
  const result = applyEdit({ contents, oldString, newString, replaceAll })
  if (!result.ok) throw new Error(result.error)
  await fs.writeFile(resolved.absolute, result.contents, 'utf8')
  return { path: resolved.relative, replacements: result.replacements }
}

// --- glob / grep directory walk -----------------------------------------

async function* walkFiles(root: string, depth: number): AsyncGenerator<string> {
  if (depth > GLOB_MAX_DEPTH) return
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    throw error
  }
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of sorted) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
      yield* walkFiles(path.join(root, entry.name), depth + 1)
      continue
    }
    if (entry.isFile()) yield path.join(root, entry.name)
  }
}

async function executeGlob(
  coding: CodingSandboxConfiguration,
  input: Readonly<Record<string, HarnessJsonValue>>
) {
  const pattern = requireString(input, 'pattern')
  const base = await resolveSearchBase(coding, input.path)
  // Compiled once outside the walk, not per file: the pattern is constant
  // for the whole search.
  const patternRegex = compileGlob(pattern)
  const files: string[] = []
  let truncated = false
  for await (const absolute of walkFiles(base, 0)) {
    const relative = path.relative(base, absolute)
    if (!patternRegex.test(relative)) continue
    if (files.length >= GLOB_MAX_RESULTS) {
      truncated = true
      break
    }
    files.push(relative)
  }
  return { path: relativeOf(coding, base), files, truncated }
}

// A regex like a valid compiled RegExp still blocks this single-threaded
// worker forever if it backtracks catastrophically (e.g. "(a+)+$" against a
// long run of 'a's) — that is not a compile error, so the length cap and
// try/catch below do not catch it. This is a narrow, deliberate exception to
// "reject nothing else": it rejects the textbook nested-repetition shape
// `(<has an unbounded repeat>)` followed by another unbounded repeat, which
// covers the common real-world ReDoS patterns without being a full regex
// parser. It does not catch every catastrophic shape (e.g. ambiguous
// alternation like "(a|a)+" repeats without any inner quantifier at all) —
// it is a heuristic, not a proof of safety. See the comment on
// GREP_MAX_MATCH_TEXT_BYTES truncation below for the other half of this
// mitigation (bounding how much of one line is ever handed back, independent
// of the pattern).
function hasCatastrophicShape(source: string): boolean {
  const groupHasQuantifier: boolean[] = []
  let inClass = false
  let index = 0
  while (index < source.length) {
    const char = source.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      index += 1
      continue
    }
    if (char === '[') {
      inClass = true
      index += 1
      continue
    }
    if (char === '(') {
      groupHasQuantifier.push(false)
      index += 1
      continue
    }
    if (char === ')') {
      const innerHadQuantifier = groupHasQuantifier.pop() ?? false
      const quantifierLength = unboundedQuantifierLengthAt(source, index + 1)
      const followedByQuantifier = quantifierLength > 0
      if (innerHadQuantifier && followedByQuantifier) return true
      const enclosing = groupHasQuantifier.length - 1
      if (enclosing >= 0 && (innerHadQuantifier || followedByQuantifier)) {
        groupHasQuantifier[enclosing] = true
      }
      index += 1 + quantifierLength
      continue
    }
    const quantifierLength = unboundedQuantifierLengthAt(source, index)
    if (quantifierLength > 0) {
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
      index += quantifierLength
      continue
    }
    if (char === '{') {
      // A bounded {n} / {n,m} is not itself a risk signal — it caps the
      // repeat count, so it cannot itself cause exponential backtracking.
      // Skip past it so its digits are never misread as more structure.
      const bounded = /^\{\d+(?:,\d+)?\}/.exec(source.slice(index))
      index += bounded ? bounded[0].length : 1
      continue
    }
    index += 1
  }
  return false
}

// Length of an *unbounded* repetition token at `index` — '+', '*', or a
// '{n,}' brace with no upper bound — or 0 if there is none there. A bounded
// '{n}' / '{n,m}' is deliberately not counted: it cannot itself cause
// exponential backtracking.
function unboundedQuantifierLengthAt(source: string, index: number): number {
  const char = source.charAt(index)
  if (char === '+' || char === '*') return 1
  if (char === '{') {
    const match = /^\{\d+,\}/.exec(source.slice(index))
    if (match) return match[0].length
  }
  return 0
}

// Explicit return type (unlike the other executors): grep returns two
// differently-shaped object literals (a soft `{ error }` and a normal
// `{ matches, truncated }`), and without an annotation TS infers their exact
// union instead of widening to HarnessJsonValue, which then fails to satisfy
// the index-signature branch of HarnessJsonValue at the call site.
async function executeGrep(
  coding: CodingSandboxConfiguration,
  input: Readonly<Record<string, HarnessJsonValue>>
): Promise<HarnessJsonValue> {
  const pattern = requireString(input, 'pattern')
  const include = input.include
  if (include !== undefined && typeof include !== 'string') {
    throw new Error('include must be a string')
  }
  const base = await resolveSearchBase(coding, input.path)

  // A bad or oversized pattern is a soft failure (returned, not thrown): the
  // model can retry with a different pattern without the run being aborted.
  if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
    return { error: `pattern must be at most ${GREP_MAX_PATTERN_LENGTH} characters` }
  }
  if (hasCatastrophicShape(pattern)) {
    return {
      error:
        'pattern rejected: nested repetition (e.g. "(a+)+") can hang the sandbox; ' +
        'narrow the group or anchor it'
    }
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    return { error: `invalid regular expression: ${humanError(error, 'could not compile pattern')}` }
  }

  // Compiled once outside the walk, not per file: include is constant for
  // the whole search.
  const includeRegex = include === undefined ? undefined : compileGlob(include)
  const matches: { file: string; line: number; text: string }[] = []
  let truncated = false
  // include matches the basename (like ripgrep's -g for a slash-free glob),
  // so a plain "*.ts" filter still finds files in nested directories.
  search: for await (const absolute of walkFiles(base, 0)) {
    if (includeRegex !== undefined && !includeRegex.test(path.basename(absolute))) continue
    let stat
    try {
      stat = await fs.stat(absolute)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue
      throw error
    }
    if (stat.size > GREP_MAX_FILE_BYTES) {
      // A skipped file makes this an incomplete search, the same as hitting
      // the match cap — without this, an oversized file silently vanishing
      // from the results looks identical to an exhaustive search that
      // legitimately found nothing there.
      truncated = true
      continue
    }
    const contents = await fs.readFile(absolute, 'utf8')
    for (const [index, line] of contents.split('\n').entries()) {
      if (!regex.test(line)) continue
      if (matches.length >= GREP_MAX_MATCHES) {
        truncated = true
        break search
      }
      // A single very long matching line must not bypass maxOutputBytes by
      // riding along in one match's `text`, independent of the pattern.
      const text =
        Buffer.byteLength(line, 'utf8') > GREP_MAX_MATCH_TEXT_BYTES
          ? truncateUtf8(line, GREP_MAX_MATCH_TEXT_BYTES, TRUNCATED_SUFFIX)
          : line
      matches.push({ file: relativeOf(coding, absolute), line: index + 1, text })
    }
  }
  return { matches, truncated }
}

// --- ls ------------------------------------------------------------------

async function executeLs(
  coding: CodingSandboxConfiguration,
  input: Readonly<Record<string, HarnessJsonValue>>
) {
  const base = await resolveSearchBase(coding, input.path)
  const entries = await fs.readdir(base, { withFileTypes: true })
  const rows = entries
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const truncated = rows.length > LS_MAX_ENTRIES
  return {
    path: relativeOf(coding, base),
    entries: truncated ? rows.slice(0, LS_MAX_ENTRIES) : rows,
    truncated
  }
}

// --- shell -----------------------------------------------------------------

function createOutputCapture(limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    append(chunk: unknown) {
      if (truncated) return
      const buffer = toBuffer(chunk)
      const available = limit - bytes
      if (buffer.byteLength > available) {
        if (available > 0) chunks.push(buffer.subarray(0, available))
        bytes = limit
        truncated = true
        return
      }
      chunks.push(buffer)
      bytes += buffer.byteLength
    },
    value() {
      const decoded = Buffer.concat(chunks, bytes).toString('utf8')
      if (!truncated && Buffer.byteLength(decoded, 'utf8') <= limit) return decoded
      return truncateUtf8(decoded, limit, TRUNCATED_SUFFIX)
    },
    wasTruncated() {
      return truncated
    }
  }
}

function toBuffer(chunk: unknown) {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

// Only PATH/HOME/LANG are forwarded — never the full process environment —
// so a sandboxed command cannot read API keys or tokens the harness process
// holds. These three are the minimum needed to resolve and run the
// allowlisted binaries predictably.
function scrubbedEnv(): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  const env: Readonly<Record<string, string | undefined>> = process.env
  if (typeof env.PATH === 'string') scrubbed.PATH = env.PATH
  if (typeof env.HOME === 'string') scrubbed.HOME = env.HOME
  if (typeof env.LANG === 'string') scrubbed.LANG = env.LANG
  return scrubbed
}

async function loadCodingSpawn(): Promise<CodingSpawn> {
  const subprocess = await import('bare-subprocess')
  const runtimeSpawn = Reflect.get(subprocess, 'spawn')
  if (typeof runtimeSpawn !== 'function') {
    throw new Error('bare-subprocess did not export spawn')
  }
  return function spawn(file, argv, options) {
    return Reflect.apply(runtimeSpawn, undefined, [
      file,
      [...argv],
      {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ])
  }
}

interface RunningShellCommand {
  readonly result: Promise<HarnessJsonValue>
  terminate(): void
}

async function executeShell(
  coding: CodingSandboxConfiguration,
  input: Readonly<Record<string, HarnessJsonValue>>,
  signal: ToolSandboxExecutionRequest['signal'],
  runtime: CodingSandboxRuntime,
  activeShellCommands: Set<RunningShellCommand>
): Promise<HarnessJsonValue> {
  const requested = requireString(input, 'command')
  const resolution = resolveAllowedCommand(requested)
  if (!resolution.ok) throw new Error(resolution.error)
  const spawn = runtime.spawn ?? (await loadCodingSpawn())
  const running = runShellCommand({ command: resolution.command, coding, signal, spawn })
  activeShellCommands.add(running)
  try {
    return await running.result
  } finally {
    activeShellCommands.delete(running)
  }
}

function runShellCommand({
  command,
  coding,
  signal,
  spawn
}: {
  readonly command: AllowedCommand
  readonly coding: CodingSandboxConfiguration
  readonly signal: ToolSandboxExecutionRequest['signal']
  readonly spawn: CodingSpawn
}): RunningShellCommand {
  if (signal.aborted) {
    return {
      result: Promise.reject(new Error(`${command.id} cancelled before it started`)),
      terminate() {}
    }
  }
  let terminate: () => void = () => {}
  const result = new Promise<HarnessJsonValue>((resolve, reject) => {
    const stdout = createOutputCapture(coding.maxOutputBytes)
    const stderr = createOutputCapture(coding.maxOutputBytes)
    let settled = false
    let exited = false
    let timedOut = false
    let cancelled = false
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let child: CodingChild

    try {
      child = spawn(command.executable, command.argv, {
        cwd: coding.projectRoot,
        env: scrubbedEnv(),
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(new Error(humanError(error, `${command.executable} failed to start`)))
      return
    }

    const settle = (run: () => void) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      signal.removeEventListener?.('abort', onAbort)
      run()
    }
    const signalChild = (name: 'SIGTERM' | 'SIGKILL') => {
      try {
        child.kill(name)
      } catch {}
    }
    const escalate = () => {
      if (settled || terminationTimer !== undefined || forceTimer !== undefined) return
      signalChild('SIGTERM')
      terminationTimer = setTimeout(() => {
        terminationTimer = undefined
        if (exited || settled) return
        signalChild('SIGKILL')
        forceTimer = setTimeout(() => {
          forceTimer = undefined
          settle(() => {
            if (cancelled) {
              reject(new Error(`${command.id} cancelled`))
              return
            }
            resolve(timedOutResult())
          })
        }, TERMINATION_GRACE_MS)
      }, TERMINATION_GRACE_MS)
    }
    const timedOutResult = () => ({
      id: command.id,
      exitCode: null,
      stdout: stdout.value(),
      stderr: stderr.value(),
      truncated: stdout.wasTruncated() || stderr.wasTruncated(),
      timedOut: true
    })
    const onAbort = () => {
      cancelled = true
      escalate()
    }
    // The provider's close() calls this exact function to force-terminate a
    // still-running command, reusing the same cancel-and-escalate path a
    // request abort would take.
    terminate = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => {
      timedOut = true
      escalate()
    }, coding.shellTimeoutMs)

    child.stdout?.on('data', stdout.append)
    child.stderr?.on('data', stderr.append)
    child.once('error', (...args) => {
      exited = true
      settle(() => reject(new Error(humanError(args[0], `${command.executable} failed`))))
    })
    child.once('exit', (...args) => {
      exited = true
      const code = typeof args[0] === 'number' ? args[0] : null
      settle(() => {
        if (cancelled) {
          reject(new Error(`${command.id} cancelled`))
          return
        }
        resolve({
          id: command.id,
          exitCode: timedOut ? code : (code ?? 1),
          stdout: stdout.value(),
          stderr: stderr.value(),
          truncated: stdout.wasTruncated() || stderr.wasTruncated(),
          timedOut
        })
      })
    })
  })
  return {
    result,
    terminate() {
      terminate()
    }
  }
}
