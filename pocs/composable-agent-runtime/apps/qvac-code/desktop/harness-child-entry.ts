import { createHarnessChildEntry } from '@qvac/harness/skill-host'
import { BUNDLED_SKILLS, BUNDLED_SKILLS_HASH } from './lib/skills/bundled-skills.ts'
import { createCodingSkillHost } from './lib/skills-impl/coding/host.ts'

/**
 * This application's harness worker. The bundler follows these static imports,
 * so this list is what the worker can serve. No sdkArgs: the coding skill
 * needs no diffusion or other sidecar arguments.
 */
export default createHarnessChildEntry({
  skills: [createCodingSkillHost()],
  skillBundle: { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
})
