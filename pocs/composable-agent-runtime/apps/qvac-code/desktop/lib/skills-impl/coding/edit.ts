// Pure, no I/O. Exact-string replacement only — no regex — so metacharacters
// in oldString (e.g. `.*`, `$1`) are matched literally rather than
// interpreted, which is what a model copying a snippet out of `read` output
// expects.
export type EditResult =
  | { readonly ok: true; readonly contents: string; readonly replacements: number }
  | { readonly ok: false; readonly error: string }

export function applyEdit(input: {
  readonly contents: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}): EditResult {
  const { contents, oldString, newString, replaceAll } = input
  if (oldString === newString) {
    return { ok: false, error: 'oldString and newString are identical' }
  }
  const count = countOccurrences(contents, oldString)
  if (count === 0) {
    return { ok: false, error: 'oldString not found in content' }
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `oldString matches ${count} locations; add more surrounding context ` +
        'to make it unique, or set replaceAll to change every occurrence'
    }
  }
  if (replaceAll) {
    return {
      ok: true,
      contents: contents.split(oldString).join(newString),
      replacements: count
    }
  }
  const index = contents.indexOf(oldString)
  const updated =
    contents.slice(0, index) + newString + contents.slice(index + oldString.length)
  return { ok: true, contents: updated, replacements: 1 }
}

function countOccurrences(haystack: string, needle: string) {
  if (needle === '') return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}
