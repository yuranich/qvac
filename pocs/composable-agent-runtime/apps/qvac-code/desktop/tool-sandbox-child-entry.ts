import { createToolSandboxChildEntry } from '@qvac/harness/skill-sandbox'
import { createCodingSkillSandbox } from './lib/skills-impl/coding/sandbox.ts'

/**
 * This application's sandbox worker. Only the in-sandbox half is imported:
 * pulling in the host half would drag path/command validation duplicated for
 * the approval flow (see host.ts) into the sandboxed bundle unnecessarily.
 */
export default createToolSandboxChildEntry({
  skills: [createCodingSkillSandbox()]
})
