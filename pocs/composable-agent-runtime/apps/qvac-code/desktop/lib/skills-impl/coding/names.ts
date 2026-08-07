// Shared by the host and sandbox halves, and by the CLI. Kept free of imports
// so neither half drags the other's dependencies into its bundle.
export const CODING_SKILL_NAME = 'qvac-code'

export const CODING_TOOL_READ = 'read'
export const CODING_TOOL_WRITE = 'write'
export const CODING_TOOL_EDIT = 'edit'
export const CODING_TOOL_GLOB = 'glob'
export const CODING_TOOL_GREP = 'grep'
export const CODING_TOOL_LS = 'ls'
export const CODING_TOOL_SHELL = 'shell'

export const CODING_TOOL_NAMES = [
  CODING_TOOL_READ,
  CODING_TOOL_WRITE,
  CODING_TOOL_EDIT,
  CODING_TOOL_GLOB,
  CODING_TOOL_GREP,
  CODING_TOOL_LS,
  CODING_TOOL_SHELL
] as const
