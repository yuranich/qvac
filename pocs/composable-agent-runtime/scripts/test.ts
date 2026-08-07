const scripts = [
  'test:config',
  'test:supervisor',
  'test:agents',
  'test:sync',
  'test:harness',
  'test:assistant',
  'test:task-shared',
  'test:task-cli',
  'test:skill-cli',
  'test:task-mobile',
  'test:qvac-code-shared',
  'test:qvac-code-desktop',
  'test:qvac-code-mobile',
  'test:crash'
]

for (const script of scripts) {
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
