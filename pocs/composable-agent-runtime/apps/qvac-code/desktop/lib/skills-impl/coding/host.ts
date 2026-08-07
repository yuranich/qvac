import path from '#path'
import type { AgentJsonValue, AgentTool } from '@qvac/agents'
import type { SkillHostProvider } from '@qvac/harness/skill-host'
import { resolveAllowedCommand } from './shell-allowlist.ts'
import { isVersionControlInternal, resolveProjectPath } from './paths.ts'
import {
  CODING_SKILL_NAME,
  CODING_TOOL_EDIT,
  CODING_TOOL_GLOB,
  CODING_TOOL_GREP,
  CODING_TOOL_LS,
  CODING_TOOL_NAMES,
  CODING_TOOL_READ,
  CODING_TOOL_SHELL,
  CODING_TOOL_WRITE
} from './names.ts'

export { CODING_SKILL_NAME } from './names.ts'

const DEFAULT_MAX_READ_BYTES = 65_536
const DEFAULT_MAX_OUTPUT_BYTES = 16_384
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const DEFAULT_READ_LIMIT = 2_000

export interface CodingSkillConfig {
  readonly projectRoot: string
  readonly projectLabel: string
  readonly executablePaths?: readonly string[]
  readonly maxReadBytes?: number
  readonly maxOutputBytes?: number
  readonly shellTimeoutMs?: number
}

interface CanonicalCodingConfig {
  readonly projectRoot: string
  readonly projectLabel: string
  readonly executablePaths: readonly string[]
  readonly maxReadBytes: number
  readonly maxOutputBytes: number
  readonly shellTimeoutMs: number
}

const READ_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_READ,
    description:
      'Read a file inside the project, prefixed by line number. Defaults to ' +
      `the first ${DEFAULT_READ_LIMIT} lines; use offset/limit to page through the rest.`,
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file, absolute or relative to the project root.'
        },
        offset: {
          type: 'integer',
          description: '1-indexed line to start from (default 1).'
        },
        limit: {
          type: 'integer',
          description: `Maximum number of lines to return (default ${DEFAULT_READ_LIMIT}).`
        }
      },
      required: ['filePath']
    }
  }
}

const WRITE_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_WRITE,
    description:
      'Create or overwrite a file inside the project. Prefer edit for a file ' +
      'that already exists; write requires the file to have been read first ' +
      'if it does.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file, absolute or relative to the project root.'
        },
        content: {
          type: 'string',
          description: 'The full file contents to write.'
        }
      },
      required: ['filePath', 'content']
    }
  }
}

const EDIT_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_EDIT,
    description:
      'Replace an exact text match in a file that has already been read in ' +
      'this session. oldString must match exactly once unless replaceAll is set.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file, absolute or relative to the project root.'
        },
        oldString: {
          type: 'string',
          description: 'Exact text to replace.'
        },
        newString: {
          type: 'string',
          description: 'Replacement text; must differ from oldString.'
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match (default false).'
        }
      },
      required: ['filePath', 'oldString', 'newString']
    }
  }
}

const GLOB_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_GLOB,
    description: 'Find files by name pattern (*, **, ?) under the project or a subdirectory.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts".'
        },
        path: {
          type: 'string',
          description: 'Directory to search from (default: project root).'
        }
      },
      required: ['pattern']
    }
  }
}

const GREP_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_GREP,
    description: 'Search file contents by regular expression under the project or a subdirectory.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for.'
        },
        path: {
          type: 'string',
          description: 'Directory to search from (default: project root).'
        },
        include: {
          type: 'string',
          description: 'Glob filtering which files are searched, e.g. "*.ts".'
        }
      },
      required: ['pattern']
    }
  }
}

const LS_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_LS,
    description: 'List the entries of one directory inside the project.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (default: project root).'
        }
      }
    }
  }
}

const SHELL_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: CODING_TOOL_SHELL,
    description:
      'Run one allowlisted command for inspecting the repo or running its own ' +
      'checks (git status/diff/log, bun test/typecheck/lint, node/bun --version). ' +
      'These run code from the project itself (tests, lint config), so this is ' +
      'not a read-only sandbox. No shell syntax is interpreted.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact allowlisted command, e.g. "git status --short".'
        }
      },
      required: ['command']
    }
  }
}

const CODING_TOOLS: readonly AgentTool[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  LS_TOOL,
  SHELL_TOOL
]

// Which argument carries a filesystem path for each tool, so validateCall can
// scope-check it generically. Tools not listed here (shell) validate
// something else instead.
const PATH_ARGUMENT: Readonly<Record<string, 'filePath' | 'path'>> = {
  [CODING_TOOL_READ]: 'filePath',
  [CODING_TOOL_WRITE]: 'filePath',
  [CODING_TOOL_EDIT]: 'filePath',
  [CODING_TOOL_GLOB]: 'path',
  [CODING_TOOL_GREP]: 'path',
  [CODING_TOOL_LS]: 'path'
}

export function createCodingSkillHost(): SkillHostProvider {
  return {
    name: CODING_SKILL_NAME,
    create({ config }) {
      const coding = canonicalConfiguration(readConfig(config))
      return {
        tools: CODING_TOOLS.map((tool) => scopedTool(tool, coding)),
        sandboxTools: [...CODING_TOOL_NAMES],
        // write, edit, and shell are side-effecting (they change files or
        // run a subprocess), so approval is not left to the agent's own
        // policy — it is required unconditionally.
        requiresApproval: [CODING_TOOL_WRITE, CODING_TOOL_EDIT, CODING_TOOL_SHELL],
        permissions() {
          return {
            writeRoots: [coding.projectRoot],
            executablePaths: coding.executablePaths,
            enabledTools: [...CODING_TOOL_NAMES],
            configuration() {
              return {
                projectRoot: coding.projectRoot,
                projectLabel: coding.projectLabel,
                maxReadBytes: coding.maxReadBytes,
                maxOutputBytes: coding.maxOutputBytes,
                shellTimeoutMs: coding.shellTimeoutMs
              }
            }
          }
        }
      }
    }
  }
}

function readConfig(config: Readonly<Record<string, AgentJsonValue>>): CodingSkillConfig {
  const projectRoot = config.projectRoot
  const projectLabel = config.projectLabel
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('qvac-code skill requires an absolute projectRoot')
  }
  if (typeof projectLabel !== 'string' || !projectLabel.trim()) {
    throw new Error('qvac-code skill requires a non-empty projectLabel')
  }
  // undefined (the key is absent) falls through to canonicalConfiguration's
  // default; any other wrong-typed value is malformed input and must throw
  // rather than being silently treated as absent — a present-but-string
  // maxReadBytes should not quietly become the default.
  const executablePaths = optionalAbsolutePathArray(config.executablePaths)
  const maxReadBytes = optionalNumber(config.maxReadBytes, 'maxReadBytes')
  const maxOutputBytes = optionalNumber(config.maxOutputBytes, 'maxOutputBytes')
  const shellTimeoutMs = optionalNumber(config.shellTimeoutMs, 'shellTimeoutMs')
  return {
    projectRoot,
    projectLabel,
    ...(executablePaths ? { executablePaths } : {}),
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(shellTimeoutMs === undefined ? {} : { shellTimeoutMs })
  }
}

function optionalNumber(value: AgentJsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    throw new Error(`qvac-code ${label} must be a number`)
  }
  return value
}

function optionalAbsolutePathArray(
  value: AgentJsonValue | undefined
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error('qvac-code executablePaths must be an array of absolute paths')
  }
  return requireAbsolutePaths(value)
}

function requireAbsolutePaths(value: readonly AgentJsonValue[]): readonly string[] {
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
      throw new Error('qvac-code executablePaths must be absolute paths')
    }
    paths.push(entry)
  }
  return paths
}

function canonicalConfiguration(input: CodingSkillConfig): CanonicalCodingConfig {
  const maxReadBytes = input.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const shellTimeoutMs = input.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
  validatePositiveInteger(maxReadBytes, 'maxReadBytes')
  validatePositiveInteger(maxOutputBytes, 'maxOutputBytes')
  validatePositiveInteger(shellTimeoutMs, 'shellTimeoutMs')
  return {
    projectRoot: input.projectRoot,
    projectLabel: input.projectLabel,
    executablePaths: input.executablePaths ?? [],
    maxReadBytes,
    maxOutputBytes,
    shellTimeoutMs
  }
}

function validatePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`qvac-code ${label} must be a positive safe integer`)
  }
}

// Deliberately duplicated with the sandbox executor's own checks in
// sandbox.ts: the host's validateCall runs before approval is requested and
// gives the user an accurate preview, while the sandbox check is the one
// that cannot be skipped. Same defence-in-depth split as the obsidian skill
// (see lib/skills-impl/obsidian/host.ts and desktop-executor.ts).
function scopedTool(tool: AgentTool, coding: CanonicalCodingConfig): AgentTool {
  const name = tool.schema.name
  if (name === CODING_TOOL_SHELL) {
    return {
      ...tool,
      validateCall(call) {
        const command = call.arguments.command
        if (typeof command !== 'string') {
          throw new Error('shell requires a command string')
        }
        const resolution = resolveAllowedCommand(command)
        if (!resolution.ok) throw new Error(resolution.error)
      }
    }
  }
  const argumentKey = PATH_ARGUMENT[name]
  if (!argumentKey) return tool
  return {
    ...tool,
    validateCall(call) {
      const requested = call.arguments[argumentKey]
      if (requested === undefined && argumentKey === 'path') return
      if (typeof requested !== 'string') {
        throw new Error(`${name} requires ${argumentKey} to be a string`)
      }
      const resolved = resolveProjectPath({ projectRoot: coding.projectRoot, requested })
      if (!resolved.ok) throw new Error(resolved.error)
      // .git is in scope for read/glob/grep/ls but never for a mutation: a
      // hook planted under .git/hooks runs with full host privileges outside
      // this skill's own sandbox the next time git runs. See paths.ts.
      if (
        (name === CODING_TOOL_WRITE || name === CODING_TOOL_EDIT) &&
        isVersionControlInternal(resolved.relative)
      ) {
        throw new Error(`refusing to ${name} ${resolved.relative}: .git is out of scope`)
      }
    }
  }
}
