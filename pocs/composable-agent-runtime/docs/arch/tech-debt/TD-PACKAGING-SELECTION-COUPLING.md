# TD-PACKAGING-SELECTION-COUPLING

Status: Open
Date: 2026-08-06
Related: [ADR 0005](../adrs/0005-application-owned-assistant-config.md)

## What this records

`qvac.assistant.yaml` selects inference capabilities and GPU backends, and
Assistant propagates that selection into the SDK bundle and the native link
step. The capability half rests on data SDK publishes. The backend half rests
on nothing: there is no seam, so Assistant scrapes filenames and appends
generated code to a file it does not own.

This note lists exactly what is coupled, which way each coupling fails, and
what upstream change would remove it. It is the answer to "does an SDK release
break us, and do we edit Assistant every time a plugin is added?"

## Coupling inventory

| # | Coupling | Fails how | Cost of an SDK change |
|---|---|---|---|
| 1 | Capability names derived from `SDK_DEFAULT_PLUGINS` specifiers (`@qvac/sdk/<type>/plugin` → `<type>`) | Loud — an unparseable specifier throws during prebuild | **None.** A plugin SDK adds is selectable immediately |
| 2 | Aliases derived from `MODEL_TYPES` minus `ModelType` | Loud — a stale alias fails its test; a missing alias is simply absent | **None.** Aliases follow SDK |
| 3 | Third-party plugins passed through as `<package>/plugin` | Loud — the SDK bundler rejects an unresolvable specifier | None |
| 4 | Generated `qvac.config.json` at the project root | Loud — a conflicting `qvac.config.{ts,mjs,js}` is rejected before it can win | Breaks if SDK changes `CONFIG_CANDIDATES` or its precedence |
| 5 | `@qvac/sdk` root import for `MODEL_TYPES` / `ModelType` | Loud — import failure at prebuild | Breaks if SDK stops exporting them from the root |
| 6 | Appended prune block in `react-native-bare-kit/android/link.mjs`, relying on the SDK template's `fs`, `path`, `addonsDir` bindings | Loud — `ReferenceError` at link time | Breaks if SDK renames those bindings or stops patching the linker |
| 7 | **Backend list** `['vulkan','opencl','metal','cpu']`, hand-written | **Silent** — a new backend is kept (fail-safe) but can never be declared or dropped | Assistant edit required per new backend |
| 8 | **`-ggml-<backend>.so` filename convention** | **Silent** — a differently named backend library is never pruned | Assistant edit required if naming changes |

Items 1–3 are the ones the question was really about, and they now cost
nothing. Items 7 and 8 are the real debt: both are Assistant guessing at data
that only the addon packages have.

## Why the backend half has no seam

`bare-link/lib/platform/android.js` copies every `.so` in an addon's
`prebuilds/<host>/<name>/` sidecar directory:

```js
for await (const file of await fs.openDir(path.resolve(prebuild, '..', name))) {
  if (/\.so(\.([0-9]+(\.[0-9]+)*))?$/.test(file.name)) { … await fs.copyFile(…) }
}
```

There is no filter argument and no manifest key. The addons manifest selects
*packages*; nothing selects files within a package. So Assistant can only act
after the copy, by deleting files it recognises by name — which is why item 8
exists at all.

The real assistant app (`wb/mobile`) does not attempt this and ships every
backend, so this is not a solved problem elsewhere in the org.

## Upstream asks, in priority order

1. **Addon packages declare their backends.** A `qvac.backends` field in each
   addon's `package.json` (`["vulkan", "opencl", "cpu"]`) mapped to the files
   that implement each. This kills items 7 and 8 outright: the set becomes
   discovered data and the file mapping stops being a guess.
2. **`bare-link` takes a file filter.** `link(root, { hosts, out, includeFile })`
   would let Assistant decide during the copy rather than deleting afterwards,
   removing item 6 — the generated code block — entirely.
3. **SDK exports a capability catalog.** `@qvac/sdk/capabilities` returning
   `[{ capability, aliases, specifier, addonPackage }]` would replace items 1,
   2, and 5 with one importable value, and would let Assistant report the addon
   a capability pulls in without inferring it.
4. **SDK exports `CONFIG_CANDIDATES`** from a public subpath, so item 4's
   precedence check stops being a copy of a private list.
5. **SDK accepts plugin selection as an Expo plugin prop.** The generated
   `qvac.config.json` exists only because `withQvacSDK` takes no options. A
   `plugins` prop would let Assistant pass the selection in memory and delete
   the generated-file seam.

Asks 1 and 2 are the ones that matter: they turn backend selection from a
convention Assistant maintains into data the packages own.

## Until then

- Backend pruning is Android-only; Apple ships signed frameworks that are not
  rewritten. An iOS build ships every backend.
- Every prune is logged, and the linker reports any `-ggml-*` backend it saw
  but does not recognise, so drift surfaces in the build log rather than as a
  silent size regression.
- `bun run report:apk` reads the backends actually present in a built APK, so
  the claim "this build ships CPU only" is checked against the artifact rather
  than against the config that requested it.
