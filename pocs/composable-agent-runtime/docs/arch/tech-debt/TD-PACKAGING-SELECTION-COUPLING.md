# TD-PACKAGING-SELECTION-COUPLING

Status: Open
Date: 2026-08-06
Related: [ADR 0005](../adrs/0005-application-owned-assistant-config.md)

## What this records

ADR 0005 has Assistant propagate one application config into the SDK bundle and
the native link step. The capability half rests on data SDK publishes. The
backend half rests on nothing: there is no seam, so Assistant scrapes filenames
and appends generated code to a file it does not own.

This is the answer to "does an SDK release break us, and do we edit Assistant
every time a plugin is added?"

## Coupling inventory

| # | Coupling | Fails how | Cost of an SDK change |
|---|---|---|---|
| 1 | Capability names derived from `SDK_DEFAULT_PLUGINS` specifiers (`@qvac/sdk/<type>/plugin` → `<type>`) | Loud — an unparseable specifier throws during prebuild | **None**, while first-party plugins keep that specifier shape. One moved to a sibling package would hard-fail every prebuild |
| 2 | Aliases derived from `MODEL_TYPES` minus `ModelType` | Loud — a stale alias fails its test; a missing alias is simply absent | **None.** Aliases follow SDK |
| 3 | Third-party plugins passed through as `<package>/plugin` | Loud — the SDK bundler rejects an unresolvable specifier | None |
| 4 | Generated `qvac.config.json` at the project root | Loud — a conflicting `qvac.config.{ts,mjs,js}` is rejected before it can win | Breaks if SDK changes `CONFIG_CANDIDATES` or its precedence |
| 5 | `@qvac/sdk` root import for `MODEL_TYPES` / `ModelType` | Loud — import failure at prebuild | Breaks if SDK stops exporting them from the root |
| 6 | Appended prune block in `react-native-bare-kit/android/link.mjs`, relying on the SDK template's `fs`, `path`, `addonsDir` bindings | Loud — `ReferenceError` at link time | Breaks if SDK renames those bindings or stops patching the linker |
| 7 | **Backend list** `['vulkan','opencl','metal','cpu']`, hand-written | **Silent** — a new backend is kept and logged, but can never be declared or dropped | Assistant edit required per new backend |
| 8 | **`-ggml-<backend>` filename convention** | **Silent** — a differently named backend library is never pruned | Assistant edit required if naming changes |

Items 7 and 8 are the debt: both are Assistant guessing at data only the addon
packages have. `@qvac/vla-ggml` already ships a `libqvac-ggml-hip.so` that
cannot be declared or dropped — linux-x64 only, so it never reaches an Android
build, but it is a live instance rather than a hypothetical.

The classifier for item 8 exists twice: `lib/packaging/barekit-linker.ts` embeds
it in generated code, and `scripts/report-apk.ts` keeps its own copy for reading
a built APK. They must stay in step or the report stops describing what was
actually pruned. Sharing them would mean a new public export, which is the
opposite of what this PoC is judged on, so the duplication is deliberate and
both carry the same comment.

## Why the backend half has no seam

`bare-link/lib/platform/android.js` copies every shared object in an addon's
`prebuilds/<host>/<name>/` sidecar directory:

```js
for await (const file of await fs.openDir(path.resolve(prebuild, '..', name))) {
  if (/\.so(\.([0-9]+(\.[0-9]+)*))?$/.test(file.name)) { … await fs.copyFile(…) }
}
```

No filter argument, no manifest key. The addons manifest selects *packages*;
nothing selects files within a package. So Assistant can only act after the
copy, deleting files it recognises by name — which is why item 8 exists.

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
   `qvac.config.json` exists only because `withQvacSDK` takes no options.

Asks 1 and 2 are the ones that matter: they turn backend selection from a
convention Assistant maintains into data the packages own. The
[assistant app](https://github.com/tetherto/qvac-app/tree/main/mobile) does not
attempt backend stripping at all, so nothing else in the org has solved this.

## Until then

- Every prune is logged, and the linker reports any `-ggml-*` backend it saw but
  does not recognise, so drift surfaces in the build log rather than as a silent
  size regression.
- `bun run report:apk` reads the backends present in a built APK, so "this build
  ships CPU only" is checked against the artifact rather than the config that
  requested it.
- The app config is resolved twice per prebuild — once to generate the SDK
  config, once in `packaging/stack-manifest.ts` to record what was selected.
  Cheap, but the manifest could in principle record a different file than the
  one propagated. Threading the resolved config through finalization would close
  that, at the cost of a parameter that exists only for a race nobody has hit.
