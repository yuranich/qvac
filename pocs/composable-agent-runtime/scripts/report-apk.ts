import { open, readdir, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

const POC_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_PROJECT_ROOT = path.join(POC_ROOT, 'apps', 'task-mobile')
const DEFAULT_APK = path.join(
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
)
const NATIVE_LIBRARY_PREFIX = 'lib/'
const UNATTRIBUTED = '(host runtime)'
const END_RECORD_LENGTH = 22
const MAX_ZIP_COMMENT = 0xffff
/** `libqvac-speech-ggml-cpu-android_armv9.2_2.so` reports as backend `cpu`. */
const BACKEND_PATTERN = /-ggml-([a-z0-9]+)(?:[-_.]|\.so$)/

interface ZipEntry {
  readonly name: string
  readonly compressedSize: number
  readonly uncompressedSize: number
}

interface LibraryRow {
  readonly name: string
  readonly abi: string
  /**
   * Every linked addon that ships this filename. Backends such as
   * `libqvac-ggml-vulkan.so` are shipped identically by several addons and
   * deduplicated to one copy in the APK, so a single owner would be a lie:
   * dropping one of those addons does not remove the bytes.
   */
  readonly owners: readonly string[]
  readonly compressedSize: number
  readonly uncompressedSize: number
}

interface OwnerRow {
  readonly owners: readonly string[]
  readonly shared: boolean
  readonly libraries: number
  readonly compressedSize: number
  readonly uncompressedSize: number
}

interface BackendRow {
  readonly backend: string
  readonly libraries: number
  readonly compressedSize: number
}

interface ApkReport {
  readonly apkPath: string
  readonly apkSize: number
  readonly nativeLibraryCompressedSize: number
  readonly nativeLibraryUncompressedSize: number
  readonly selectedPlugins: readonly string[] | null
  readonly linkedAddons: readonly string[]
  /** ggml backends actually present, read from the APK rather than from config. */
  readonly backends: readonly BackendRow[]
  readonly owners: readonly OwnerRow[]
  readonly libraries: readonly LibraryRow[]
}

await main()

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const apkPath = path.isAbsolute(options.apk)
    ? options.apk
    : path.join(options.projectRoot, options.apk)

  const apkStat = await stat(apkPath)
  const entries = await readZipCentralDirectory(apkPath, apkStat.size)
  const linkedAddons = await readLinkedAddons(options.projectRoot)
  const selectedPlugins = await readSelectedPlugins(options.projectRoot)
  const owners = await mapLibraryOwners(options.projectRoot, linkedAddons)

  const libraries = entries
    .filter((entry) => entry.name.startsWith(NATIVE_LIBRARY_PREFIX) && entry.name.endsWith('.so'))
    .map((entry) => toLibraryRow(entry, owners))
    .sort((left, right) => right.compressedSize - left.compressedSize)

  const report: ApkReport = {
    apkPath,
    apkSize: apkStat.size,
    nativeLibraryCompressedSize: sumBy(libraries, (entry) => entry.compressedSize),
    nativeLibraryUncompressedSize: sumBy(libraries, (entry) => entry.uncompressedSize),
    selectedPlugins,
    linkedAddons,
    backends: summarizeBackends(libraries),
    owners: summarizeOwners(libraries),
    libraries
  }

  printReport(report)
  if (options.json) {
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`▸ Wrote JSON report to ${options.json}`)
  }
}

function printReport(report: ApkReport) {
  console.log(`▸ APK ${report.apkPath}`)
  console.log(`▸ Total APK size ${formatBytes(report.apkSize)}`)
  console.log(
    `▸ Native libraries ${report.libraries.length} entries, ` +
      `${formatBytes(report.nativeLibraryCompressedSize)} stored / ` +
      `${formatBytes(report.nativeLibraryUncompressedSize)} unpacked ` +
      `(${formatPercent(report.nativeLibraryCompressedSize, report.apkSize)} of the APK)`
  )
  console.log(
    `▸ SDK worker plugins ${
      report.selectedPlugins === null
        ? 'all built-in (no selection recorded)'
        : `${report.selectedPlugins.length} selected`
    }`
  )
  for (const plugin of report.selectedPlugins ?? []) console.log(`    ${plugin}`)
  console.log(`▸ Linked native addons ${report.linkedAddons.length}`)
  console.log(
    `▸ ggml backends ${
      report.backends.length === 0
        ? 'none'
        : report.backends
            .map(
              (entry) =>
                `${entry.backend} (${entry.libraries}, ${formatBytes(entry.compressedSize)})`
            )
            .join(', ')
    }`
  )

  console.log('')
  console.log(padRight('OWNER', 46) + padLeft('STORED', 12) + padLeft('LIBS', 6))
  for (const owner of report.owners) {
    console.log(
      padRight(formatOwners(owner.owners), 46) +
        padLeft(formatBytes(owner.compressedSize), 12) +
        padLeft(String(owner.libraries), 6)
    )
  }

  console.log('')
  console.log(padRight('LIBRARY', 46) + padLeft('STORED', 12) + '  OWNER')
  for (const library of report.libraries) {
    console.log(
      padRight(library.name, 46) +
        padLeft(formatBytes(library.compressedSize), 12) +
        `  ${formatOwners(library.owners)}`
    )
  }
}

function toLibraryRow(
  entry: ZipEntry,
  owners: ReadonlyMap<string, readonly string[]>
): LibraryRow {
  const segments = entry.name.split('/')
  const fileName = segments.at(-1) ?? entry.name
  const shippedBy = owners.get(fileName)
  const decoded = decodeAddonFromLibraryName(fileName)
  return {
    name: fileName,
    abi: segments.at(-2) ?? 'unknown',
    owners: shippedBy ?? (decoded === null ? [UNATTRIBUTED] : [decoded]),
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize
  }
}

function summarizeBackends(libraries: readonly LibraryRow[]) {
  const byBackend = new Map<string, BackendRow>()
  for (const library of libraries) {
    const backend = BACKEND_PATTERN.exec(library.name)?.[1]
    if (backend === undefined) continue
    const previous = byBackend.get(backend)
    byBackend.set(backend, {
      backend,
      libraries: (previous?.libraries ?? 0) + 1,
      compressedSize: (previous?.compressedSize ?? 0) + library.compressedSize
    })
  }
  return [...byBackend.values()].sort(
    (left, right) => right.compressedSize - left.compressedSize
  )
}

function summarizeOwners(libraries: readonly LibraryRow[]) {
  const byOwner = new Map<string, OwnerRow>()
  for (const library of libraries) {
    const key = library.owners.join(', ')
    const previous = byOwner.get(key)
    byOwner.set(key, {
      owners: library.owners,
      shared: library.owners.length > 1,
      libraries: (previous?.libraries ?? 0) + 1,
      compressedSize: (previous?.compressedSize ?? 0) + library.compressedSize,
      uncompressedSize: (previous?.uncompressedSize ?? 0) + library.uncompressedSize
    })
  }
  return [...byOwner.values()].sort((left, right) => right.compressedSize - left.compressedSize)
}

function formatOwners(owners: readonly string[]) {
  const [first, ...rest] = owners
  if (rest.length === 0) return first ?? UNATTRIBUTED
  return `${first} +${rest.length} shared`
}

/**
 * Maps each prebuilt `.so` filename back to the addon package that ships it, by
 * reading every linked addon's `prebuilds/android-*` tree. Sidecar backends such
 * as `libqvac-ggml-vulkan.so` carry no package name of their own, so the shipping
 * package is the only way to attribute their bytes.
 */
async function mapLibraryOwners(projectRoot: string, addonNames: readonly string[]) {
  const owners = new Map<string, string[]>()
  for (const addonName of addonNames) {
    const packageDirectory = await findPackageDirectory(projectRoot, addonName)
    if (packageDirectory === null) continue
    const prebuilds = path.join(packageDirectory, 'prebuilds')
    for (const host of await listDirectory(prebuilds)) {
      if (!host.startsWith('android-')) continue
      await collectLibraryNames(path.join(prebuilds, host), addonName, owners)
    }
  }
  return owners as ReadonlyMap<string, readonly string[]>
}

async function collectLibraryNames(
  directory: string,
  addonName: string,
  owners: Map<string, string[]>
) {
  for (const entry of await listDirectory(directory)) {
    const entryPath = path.join(directory, entry)
    const entryStat = await stat(entryPath).catch(() => null)
    if (entryStat === null) continue
    if (entryStat.isDirectory()) {
      await collectLibraryNames(entryPath, addonName, owners)
      continue
    }
    if (!entry.endsWith('.so')) continue
    const shippedBy = owners.get(entry)
    if (shippedBy === undefined) owners.set(entry, [addonName])
    else if (!shippedBy.includes(addonName)) shippedBy.push(addonName)
  }
}

/** `libqvac__llm-llamacpp.0.36.4.so` is the linker's encoding of `@qvac/llm-llamacpp`. */
function decodeAddonFromLibraryName(fileName: string) {
  const match = fileName.match(/^lib(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.so$/)
  if (!match) return null
  const encoded = match[1] ?? ''
  if (!encoded.includes('__')) return encoded
  const [scope, name] = encoded.split('__', 2)
  return scope && name ? `@${scope}/${name}` : encoded
}

async function readLinkedAddons(projectRoot: string) {
  const manifestPath = path.join(projectRoot, 'qvac', 'addons.manifest.json')
  const parsed = await readJson(manifestPath)
  if (parsed === null) return []
  const addons = Reflect.get(parsed, 'addons')
  if (!Array.isArray(addons) || !addons.every((entry) => typeof entry === 'string')) {
    throw new Error(`Malformed addons manifest: ${manifestPath}`)
  }
  return addons
}

async function readSelectedPlugins(projectRoot: string) {
  const parsed = await readJson(path.join(projectRoot, 'qvac.config.json'))
  if (parsed === null) return null
  const plugins = Reflect.get(parsed, 'plugins')
  if (plugins === undefined) return null
  if (!Array.isArray(plugins) || !plugins.every((entry) => typeof entry === 'string')) {
    throw new Error(`Malformed plugins list in ${path.join(projectRoot, 'qvac.config.json')}`)
  }
  return plugins
}

async function readJson(filePath: string) {
  let source: string
  try {
    source = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  const parsed: unknown = JSON.parse(source)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Malformed JSON object: ${filePath}`)
  }
  return parsed
}

async function findPackageDirectory(projectRoot: string, packageName: string) {
  let currentDirectory = path.resolve(projectRoot)
  const rootDirectory = path.parse(currentDirectory).root
  while (true) {
    const candidate = path.join(currentDirectory, 'node_modules', ...packageName.split('/'))
    const candidateStat = await stat(candidate).catch(() => null)
    if (candidateStat?.isDirectory()) return candidate
    if (currentDirectory === rootDirectory) return null
    currentDirectory = path.dirname(currentDirectory)
  }
}

async function listDirectory(directory: string) {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

/**
 * Reads the zip central directory so sizes come from the archive itself rather
 * than from an external `unzip`. Only the trailer and the directory are read —
 * an APK is hundreds of megabytes and none of its entry bodies are needed.
 * ZIP64 archives are rejected explicitly rather than reported with truncated
 * sizes.
 */
async function readZipCentralDirectory(
  apkPath: string,
  apkSize: number
): Promise<readonly ZipEntry[]> {
  const handle = await open(apkPath, 'r')
  try {
    const trailerLength = Math.min(apkSize, MAX_ZIP_COMMENT + END_RECORD_LENGTH)
    const trailer = await readAt(handle, apkSize - trailerLength, trailerLength)
    const endOffset = findEndOfCentralDirectory(trailer, apkPath)
    const entryCount = trailer.readUInt16LE(endOffset + 10)
    const directorySize = trailer.readUInt32LE(endOffset + 12)
    const directoryOffset = trailer.readUInt32LE(endOffset + 16)
    if (
      directoryOffset === 0xffffffff ||
      directorySize === 0xffffffff ||
      entryCount === 0xffff
    ) {
      throw new Error(`ZIP64 archives are not supported: ${apkPath}`)
    }

    const directory = await readAt(handle, directoryOffset, directorySize)
    const entries: ZipEntry[] = []
    let cursor = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error(`Malformed zip central directory entry ${index} in ${apkPath}`)
      }
      const nameLength = directory.readUInt16LE(cursor + 28)
      entries.push({
        name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
        compressedSize: directory.readUInt32LE(cursor + 20),
        uncompressedSize: directory.readUInt32LE(cursor + 24)
      })
      cursor +=
        46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32)
    }
    return entries
  } finally {
    await handle.close()
  }
}

async function readAt(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) {
    throw new Error(`Short read of ${length} bytes at offset ${position}`)
  }
  return buffer
}

function findEndOfCentralDirectory(trailer: Buffer, apkPath: string) {
  for (let offset = trailer.length - END_RECORD_LENGTH; offset >= 0; offset -= 1) {
    if (trailer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error(`Not a zip archive: ${apkPath}`)
}

function parseArguments(argv: readonly string[]) {
  let projectRoot = DEFAULT_PROJECT_ROOT
  let apk = DEFAULT_APK
  let json: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    if (flag === '--project-root') projectRoot = path.resolve(value)
    else if (flag === '--apk') apk = value
    else if (flag === '--json') json = path.resolve(value)
    else throw new Error(`Unknown argument: ${flag}`)
    index += 1
  }
  return { projectRoot, apk, json }
}

function sumBy<T>(items: readonly T[], select: (item: T) => number) {
  return items.reduce((total, item) => total + select(item), 0)
}

function formatBytes(value: number) {
  const megabytes = value / (1024 * 1024)
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`
  return `${(value / 1024).toFixed(0)} KB`
}

function formatPercent(value: number, total: number) {
  if (total === 0) return '0%'
  return `${((value / total) * 100).toFixed(1)}%`
}

function padRight(value: string, width: number) {
  return value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width)
}

function padLeft(value: string, width: number) {
  return value.padStart(width)
}
