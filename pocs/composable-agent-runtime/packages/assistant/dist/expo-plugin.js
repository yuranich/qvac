// lib/expo/plugin.ts
import {
  createRunOncePlugin,
  withDangerousMod,
  withPlugins,
  withRunOnce
} from "@expo/config-plugins";
import path7 from "node:path";
import { createHarnessExpoPlugin } from "@qvac/harness/expo-plugin";
import sdkExpoPlugin from "@qvac/sdk/expo-plugin";
import { createSyncExpoPlugin } from "@qvac/sync/expo-plugin";

// lib/packaging/addon-inventory.ts
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
var packageVersionTreeCache = new Map;
function mergeAddonInventories(sdkSourceAddons, syncAddons, harnessAddons) {
  const addonsByName = new Map;
  for (const addon of sdkSourceAddons) {
    addonsByName.set(addon.name, addon);
  }
  for (const addon of [...syncAddons, ...harnessAddons]) {
    const previous = addonsByName.get(addon.name);
    if (!previous) {
      addonsByName.set(addon.name, addon);
      continue;
    }
    if (previous.version !== addon.version) {
      throw new Error(`Conflicting versions for native addon ${addon.name}: ${previous.version} vs ${addon.version}`);
    }
  }
  return [...addonsByName.values()].sort(compareAddons);
}
async function resolveAddonsByAncestor(projectRoot, addonNames) {
  const result = [];
  for (const addonName of addonNames) {
    const version = await resolvePackageVersion(projectRoot, addonName);
    result.push({ name: addonName, version });
  }
  result.sort(compareAddons);
  return result;
}
function compareAddons(left, right) {
  if (left.name !== right.name)
    return left.name.localeCompare(right.name);
  return left.version.localeCompare(right.version);
}
async function resolvePackageVersion(projectRoot, packageName) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName);
  const source = await readFileStrict(packageJsonPath, `package metadata for ${packageName}`);
  const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`);
  if (!isObject(parsed) || typeof parsed.version !== "string") {
    throw new Error(`Malformed package metadata for ${packageName}: ${packageJsonPath}`);
  }
  return parsed.version;
}
async function readPackageVersions(projectRoot) {
  const assistantPackageJsonPath = resolveAssistantPackageJsonPath();
  const assistantSource = await readFileStrict(assistantPackageJsonPath, "assistant package metadata");
  const assistantParsed = parseJson(assistantSource, assistantPackageJsonPath, "assistant package metadata");
  if (!isObject(assistantParsed) || typeof assistantParsed.version !== "string") {
    throw new Error(`Malformed assistant package metadata: ${assistantPackageJsonPath}`);
  }
  return {
    assistant: assistantParsed.version,
    sync: await resolvePackageVersion(projectRoot, "@qvac/sync"),
    harness: await resolvePackageVersion(projectRoot, "@qvac/harness"),
    sdk: await resolvePackageVersion(projectRoot, "@qvac/sdk")
  };
}
function readAssistantPackageVersion() {
  const require2 = createRequire(import.meta.url);
  const packageJson = require2(resolveAssistantPackageJsonPath());
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Assistant package version is required for expo plugin provenance.");
  }
  return packageJson.version;
}
function resolveAssistantPackageJsonPath() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.basename(moduleDirectory) === "dist" ? path.dirname(moduleDirectory) : path.resolve(moduleDirectory, "../..");
  return path.join(packageRoot, "package.json");
}
async function readFileStrict(filePath, label) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }
}
function parseJson(source, filePath, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${label} JSON at ${filePath}: ${message}`);
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
async function findPackageJsonInAncestors(projectRoot, packageName) {
  let currentDirectory = path.resolve(projectRoot);
  const rootDirectory = path.parse(currentDirectory).root;
  while (true) {
    const candidate = path.join(currentDirectory, "node_modules", ...packageName.split("/"), "package.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      if (currentDirectory === rootDirectory)
        break;
      currentDirectory = path.dirname(currentDirectory);
    }
  }
  throw new Error(`Unable to resolve required package version for ${packageName} from ancestor node_modules of ${projectRoot}`);
}

// lib/expo/app-config.ts
import { access as access2, readFile as readFile2, writeFile } from "node:fs/promises";
import path2 from "node:path";
import { parse as parseYaml } from "yaml";

// lib/expo/capabilities.ts
import { MODEL_TYPES, ModelType } from "@qvac/sdk";
import { SDK_DEFAULT_PLUGINS } from "@qvac/sdk/plugin-utils";
var SPECIFIER_PATTERN = /^@qvac\/sdk\/(.+)\/plugin$/;
var catalog = null;
function capabilityCatalog() {
  if (catalog === null)
    catalog = buildCapabilityCatalog();
  return catalog;
}
function buildCapabilityCatalog(specifierList = SDK_DEFAULT_PLUGINS, modelTypes = MODEL_TYPES, canonicalModelTypes = ModelType) {
  const specifiers = new Map;
  for (const specifier of specifierList) {
    const canonical = SPECIFIER_PATTERN.exec(specifier)?.[1];
    if (canonical === undefined || canonical.includes("/")) {
      throw new Error(`Unrecognised SDK plugin specifier: ${specifier}. ` + "Assistant derives capability names from the specifier, so this " + "must be reviewed against the installed @qvac/sdk.");
    }
    specifiers.set(canonical, specifier);
  }
  const canonicalKeys = new Set(Object.keys(canonicalModelTypes));
  const aliases = new Map;
  for (const [key, value] of Object.entries(modelTypes)) {
    if (canonicalKeys.has(key) || !specifiers.has(value))
      continue;
    aliases.set(key, value);
  }
  return { specifiers, aliases };
}
function capabilityNames(source = capabilityCatalog()) {
  return [...source.specifiers.keys(), ...source.aliases.keys()].sort();
}
function resolveCapability(name, source = capabilityCatalog()) {
  if (name.endsWith("/plugin"))
    return { capability: name, specifier: name };
  const specifier = source.specifiers.get(name);
  if (specifier !== undefined)
    return { capability: name, specifier };
  const canonical = source.aliases.get(name);
  if (canonical === undefined)
    return null;
  const aliased = source.specifiers.get(canonical);
  if (aliased === undefined)
    return null;
  return { capability: canonical, specifier: aliased };
}

// lib/expo/types.ts
var ASSISTANT_INFERENCE_ACCELERATORS = Object.freeze([
  "vulkan",
  "opencl",
  "metal",
  "cpu"
]);
var ASSISTANT_STACK_MANIFEST_VERSION = 4;
var ASSISTANT_MANIFEST_PROVENANCE_VERSION = 1;
var WORKER_ADAPTER_VERSION = 1;
var PLUGIN_EXECUTION_ORDER = Object.freeze([
  "resolve-assistant-app-config",
  "sync-contributor-plugin",
  "harness-contributor-plugin",
  "invoke-sdk-expo-plugin",
  "finalize-assistant-stack"
]);
var SDK_PLUGIN_ID = "@qvac/sdk/expo-plugin";
var SYNC_PLUGIN_ID = "@qvac/sync/expo-plugin";
var HARNESS_PLUGIN_ID = "@qvac/harness/expo-plugin";
var ASSISTANT_PLUGIN_ID = "@qvac/assistant/expo-plugin";
var ASSISTANT_FINALIZE_RUN_ONCE = "@qvac/assistant/expo-plugin/finalize";
var ASSISTANT_APP_CONFIG_RUN_ONCE = "@qvac/assistant/expo-plugin/app-config";
var REQUIRED_MOBILE_HOSTS = Object.freeze([
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator"
]);

// lib/expo/app-config.ts
var ASSISTANT_CONFIG_FILENAMES = Object.freeze([
  "qvac.assistant.yaml",
  "qvac.assistant.yml"
]);
var GENERATED_SDK_CONFIG_FILENAME = "qvac.config.json";
var CONFLICTING_SDK_CONFIG_FILENAMES = Object.freeze([
  "qvac.config.ts",
  "qvac.config.mjs",
  "qvac.config.js"
]);
var GENERATED_SDK_CONFIG_MARKER = "Generated by @qvac/assistant/expo-plugin from qvac.assistant.yaml. Do not edit.";
var LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug", "off"]);
var SUPPORTED_CONFIG_VERSION = 1;
var TOP_LEVEL_KEYS = Object.freeze(["version", "logging", "inference"]);
var LOGGING_KEYS = Object.freeze(["level"]);
var INFERENCE_KEYS = Object.freeze([
  "capabilities",
  "accelerators",
  "bareRuntimeVersion"
]);
async function findAssistantConfigFile(projectRoot) {
  const present = [];
  for (const filename of ASSISTANT_CONFIG_FILENAMES) {
    const candidate = path2.join(projectRoot, filename);
    try {
      await access2(candidate);
      present.push(candidate);
    } catch {
      continue;
    }
  }
  if (present.length > 1) {
    throw new Error(`Multiple assistant config files in ${projectRoot}: ` + `${present.map((entry) => path2.basename(entry)).join(", ")}. Keep exactly one.`);
  }
  return present[0] ?? null;
}
async function resolveAssistantAppConfig(projectRoot) {
  const configPath = await findAssistantConfigFile(projectRoot);
  if (configPath === null)
    return null;
  const source = await readFile2(configPath, "utf8");
  const parsed = parseAssistantConfig(source, configPath);
  const capabilities = parsed.inference?.capabilities ?? null;
  return {
    configPath,
    capabilities: capabilities === null ? null : capabilities.map((entry) => entry.capability),
    plugins: capabilities === null ? null : capabilities.map((entry) => entry.specifier),
    accelerators: parsed.inference?.accelerators ?? null,
    ...parsed.logging?.level ? { loggerLevel: parsed.logging.level } : {},
    ...parsed.inference?.bareRuntimeVersion ? { bareRuntimeVersion: parsed.inference.bareRuntimeVersion } : {}
  };
}
async function writeGeneratedSdkConfig(projectRoot, resolved) {
  const targetPath = path2.join(projectRoot, GENERATED_SDK_CONFIG_FILENAME);
  await assertNoConflictingSdkConfig(projectRoot, resolved.configPath);
  await assertGeneratedOrAbsent(targetPath, resolved.configPath);
  const generated = {
    "//": GENERATED_SDK_CONFIG_MARKER,
    ...resolved.plugins === null ? {} : { plugins: [...resolved.plugins] },
    ...resolved.loggerLevel === undefined ? {} : { loggerLevel: resolved.loggerLevel },
    ...resolved.bareRuntimeVersion === undefined ? {} : { bareRuntimeVersion: resolved.bareRuntimeVersion }
  };
  await writeFile(targetPath, `${JSON.stringify(generated, null, 2)}
`);
  return targetPath;
}
async function assertNoConflictingSdkConfig(projectRoot, configPath) {
  for (const filename of CONFLICTING_SDK_CONFIG_FILENAMES) {
    try {
      await access2(path2.join(projectRoot, filename));
    } catch {
      continue;
    }
    throw new Error(`Conflicting SDK configuration: ${filename} takes precedence over the ` + `${GENERATED_SDK_CONFIG_FILENAME} generated from ${path2.basename(configPath)}. ` + `Remove ${filename} and declare inference capabilities in ${path2.basename(configPath)}.`);
  }
}
async function assertGeneratedOrAbsent(targetPath, configPath) {
  let source;
  try {
    source = await readFile2(targetPath, "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Refusing to overwrite unparseable ${GENERATED_SDK_CONFIG_FILENAME} at ${targetPath}: ` + `${message}. Assistant generates this file from ${path2.basename(configPath)}; ` + "delete it, or fix its JSON if it was hand-written.");
  }
  if (isObject(parsed) && parsed["//"] === GENERATED_SDK_CONFIG_MARKER)
    return;
  throw new Error(`Refusing to overwrite hand-written ${GENERATED_SDK_CONFIG_FILENAME} at ${targetPath}. ` + `Move its settings into ${path2.basename(configPath)} and delete the file.`);
}
function parseAssistantConfig(source, configPath) {
  let document;
  try {
    document = parseYaml(source);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Malformed assistant config YAML at ${configPath}: ${message}`);
  }
  if (!isObject(document)) {
    throw new Error(`Assistant config must be a mapping: ${configPath}`);
  }
  assertKnownKeys(document, TOP_LEVEL_KEYS, configPath, "assistant config");
  if (document.version !== SUPPORTED_CONFIG_VERSION) {
    throw new Error(`Unsupported assistant config version at ${configPath}: ` + `expected ${SUPPORTED_CONFIG_VERSION}, got ${JSON.stringify(document.version)}`);
  }
  return {
    version: SUPPORTED_CONFIG_VERSION,
    ...parseLogging(document.logging, configPath),
    ...parseInference(document.inference, configPath)
  };
}
function parseLogging(value, configPath) {
  if (value === undefined || value === null)
    return {};
  if (!isObject(value))
    throw new Error(`logging must be a mapping: ${configPath}`);
  assertKnownKeys(value, LOGGING_KEYS, configPath, "logging");
  const level = value.level;
  if (level === undefined || level === null)
    return {};
  if (typeof level !== "string" || !isLogLevel(level)) {
    throw new Error(`logging.level must be one of ${LOG_LEVELS.join(", ")} at ${configPath}, ` + `got ${JSON.stringify(level)}`);
  }
  return { logging: { level } };
}
function parseInference(value, configPath) {
  if (value === undefined || value === null)
    return {};
  if (!isObject(value))
    throw new Error(`inference must be a mapping: ${configPath}`);
  assertKnownKeys(value, INFERENCE_KEYS, configPath, "inference");
  const bareRuntimeVersion = value.bareRuntimeVersion;
  if (bareRuntimeVersion !== undefined && bareRuntimeVersion !== null && (typeof bareRuntimeVersion !== "string" || bareRuntimeVersion.length === 0)) {
    throw new Error(`inference.bareRuntimeVersion must be a non-empty string: ${configPath}`);
  }
  const accelerators = parseAccelerators(value.accelerators, configPath);
  return {
    inference: {
      capabilities: parseCapabilities(value.capabilities, configPath),
      ...accelerators === null ? {} : { accelerators },
      ...typeof bareRuntimeVersion === "string" ? { bareRuntimeVersion } : {}
    }
  };
}
function parseAccelerators(value, configPath) {
  if (value === undefined || value === null)
    return null;
  if (!Array.isArray(value)) {
    throw new Error(`inference.accelerators must be a list: ${configPath}`);
  }
  const selected = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isAccelerator(entry)) {
      throw new Error(`Unknown inference accelerator ${JSON.stringify(entry)} at ${configPath}. ` + `Valid accelerators: ${ASSISTANT_INFERENCE_ACCELERATORS.join(", ")}`);
    }
    if (selected.includes(entry)) {
      throw new Error(`Duplicate inference accelerator ${entry} at ${configPath}`);
    }
    selected.push(entry);
  }
  return Object.freeze([...selected].sort());
}
function parseCapabilities(value, configPath) {
  if (value === undefined || value === null) {
    throw new Error(`inference.capabilities is required when inference is declared at ${configPath}. ` + "Remove the inference section to keep every built-in capability.");
  }
  if (!Array.isArray(value)) {
    throw new Error(`inference.capabilities must be a list: ${configPath}`);
  }
  if (value.length === 0) {
    throw new Error(`inference.capabilities must name at least one capability at ${configPath}. ` + "Remove the inference section to keep every built-in capability.");
  }
  const selected = [];
  for (const entry of value) {
    const resolved = typeof entry === "string" ? resolveCapability(entry) : null;
    if (resolved === null) {
      throw new Error(`Unknown inference capability ${JSON.stringify(entry)} at ${configPath}. ` + `Valid capabilities: ${capabilityNames().join(", ")}. ` + "A third-party plugin is named by its specifier, as in my-plugin/plugin.");
    }
    if (selected.some((existing) => existing.capability === resolved.capability)) {
      throw new Error(`Duplicate inference capability ${resolved.capability} at ${configPath}`);
    }
    selected.push(resolved);
  }
  return Object.freeze([...selected].sort((left, right) => left.capability.localeCompare(right.capability)));
}
function assertKnownKeys(value, allowed, configPath, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0)
    return;
  throw new Error(`Unknown ${label} key ${unknown.map((key) => JSON.stringify(key)).join(", ")} ` + `at ${configPath}. Valid keys: ${allowed.join(", ")}`);
}
function isAccelerator(value) {
  return ASSISTANT_INFERENCE_ACCELERATORS.includes(value);
}
function isLogLevel(value) {
  return LOG_LEVELS.includes(value);
}

// lib/expo/contribution.ts
import { access as access3, readFile as readFile3 } from "node:fs/promises";
import path3 from "node:path";
async function readPackageContributions(projectRoot, overrides = {}) {
  const syncContribution = overrides.syncContribution ?? await readContributionFile(projectRoot, "sync", "qvac.sync", "@qvac/sync");
  const harnessContribution = overrides.harnessContribution ?? await readContributionFile(projectRoot, "harness", "qvac.harness", "@qvac/harness");
  return {
    sync: contributionToInventory("sync", syncContribution),
    harness: contributionToInventory("harness", harnessContribution)
  };
}
async function readContributionFile(projectRoot, role, expectedContract, expectedPackageName) {
  const contributionPath = path3.join(projectRoot, "qvac", "contributions", `${role}.json`);
  let source = "";
  try {
    await access3(contributionPath);
    source = await readFile3(contributionPath, "utf8");
  } catch {
    throw new Error(`Missing ${role} contribution: ${contributionPath}. ` + `Run @qvac/${role}/expo-plugin in contributor mode before assistant finalization.`);
  }
  const parsed = parseJson(source, contributionPath, `${role} contribution`);
  return validateContribution(parsed, role, expectedContract, expectedPackageName, contributionPath);
}
function validateContribution(value, role, expectedContract, expectedPackageName, contributionPath) {
  if (!isObject(value)) {
    throw new Error(`Malformed ${role} contribution: ${contributionPath}`);
  }
  const schemaVersion = value.schemaVersion;
  const packageName = value.packageName;
  const packageVersion = value.packageVersion;
  const contract = value.contract;
  const protocolVersion = value.protocolVersion;
  const bundleId = value.bundleId;
  const hosts = value.hosts;
  const nativeAddons = value.nativeAddons;
  const packages = value.packages;
  const harnessPath = value.harnessPath;
  const metadataPath = value.metadataPath;
  const bundlePath = value.bundlePath;
  const hasHosts = Array.isArray(hosts) && hosts.every((entry) => typeof entry === "string") && REQUIRED_MOBILE_HOSTS.every((requiredHost) => hosts.includes(requiredHost));
  const hasAddons = Array.isArray(nativeAddons) && nativeAddons.every((entry) => isObject(entry) && typeof entry.name === "string" && typeof entry.version === "string");
  const hasPackages = Array.isArray(packages) && packages.every((entry) => isObject(entry) && typeof entry.name === "string" && typeof entry.version === "string" && typeof entry.packagePath === "string" && typeof entry.singleton === "boolean");
  if (schemaVersion !== 1 || packageName !== expectedPackageName || typeof packageVersion !== "string" || packageVersion.length === 0 || contract !== expectedContract || protocolVersion !== WORKER_ADAPTER_VERSION || typeof bundleId !== "string" || bundleId.length === 0 || !hasHosts || !hasAddons || !hasPackages || typeof harnessPath !== "string" || harnessPath.length === 0 || typeof metadataPath !== "string" || metadataPath.length === 0 || typeof bundlePath !== "string" || bundlePath.length === 0) {
    if (typeof protocolVersion === "number" && protocolVersion !== WORKER_ADAPTER_VERSION) {
      throw new Error(`Protocol mismatch in ${role} contribution: expected ${WORKER_ADAPTER_VERSION}, got ${protocolVersion}`);
    }
    if (Array.isArray(hosts) && !hasHosts) {
      throw new Error(`Host mismatch in ${role} contribution: required mobile hosts are missing at ${contributionPath}`);
    }
    throw new Error(`Malformed ${role} contribution: ${contributionPath}`);
  }
  return {
    schemaVersion: 1,
    packageName: expectedPackageName,
    packageVersion,
    contract: expectedContract,
    protocolVersion: WORKER_ADAPTER_VERSION,
    bundleId,
    hosts: [...hosts].sort(),
    nativeAddons,
    packages,
    harnessPath,
    metadataPath,
    bundlePath
  };
}
function contributionToInventory(role, contribution) {
  return {
    role,
    contract: contribution.contract,
    protocolVersion: contribution.protocolVersion,
    bundleId: contribution.bundleId,
    hosts: [...contribution.hosts].sort(),
    nativeAddons: [...contribution.nativeAddons],
    packages: [...contribution.packages]
  };
}

// lib/packaging/stack-manifest.ts
import { mkdir, writeFile as writeFile3 } from "node:fs/promises";
import path6 from "node:path";

// lib/artifact-validation.ts
import { readdir as readdir2, readFile as readFile4, realpath, stat } from "node:fs/promises";
import path4 from "node:path";
async function validateArtifacts(options) {
  const singletonPackages = new Set(options.singletonPackages);
  const realms = await Promise.all(options.realms.map(async (realm) => ({
    ...realm,
    packages: realm.packages?.map((instance) => ({
      ...instance,
      singleton: instance.singleton || singletonPackages.has(instance.name)
    })) ?? await resolveRealmPackages(options.projectRoot, realm.roots, singletonPackages)
  })));
  const errors = [];
  validateRealmDuplicates(realms, errors);
  const expectedAddons = validateAddonUnion(options, errors);
  validateInstalledAddonVersions(realms, expectedAddons, errors);
  if (options.stagedResources) {
    const requiredAddons = await filterRequiredAddons(options.projectRoot, expectedAddons, options.targetHost);
    validateStagedResources(options.stagedResources, expectedAddons, requiredAddons, errors);
  }
  return {
    ok: errors.length === 0,
    errors,
    realms,
    nativeAddons: expectedAddons
  };
}
async function filterRequiredAddons(projectRoot, addons, targetHost) {
  if (targetHost !== "android")
    return addons;
  const required = [];
  for (const addon of addons) {
    const manifestPath = await resolvePackageManifest(addon.name, projectRoot);
    const manifest = await readManifest(manifestPath);
    if (manifest.version === addon.version && hasUnsupportedAndroidExport(manifest.exports)) {
      continue;
    }
    required.push(addon);
  }
  return required;
}
function hasUnsupportedAndroidExport(exportsValue) {
  if (typeof exportsValue !== "object" || exportsValue === null || Array.isArray(exportsValue)) {
    return false;
  }
  const rootExport = Reflect.get(exportsValue, ".");
  if (typeof rootExport !== "object" || rootExport === null || Array.isArray(rootExport)) {
    return false;
  }
  const android = Reflect.get(rootExport, "android");
  return typeof android === "string" && /(?:^|\/)unsupported\.[cm]?js$/.test(android);
}
function validateInstalledAddonVersions(realms, addons, errors) {
  const installed = new Set(realms.flatMap((realm) => (realm.packages ?? []).map((instance) => `${instance.name}@${instance.version}`)));
  for (const addon of addons) {
    if (installed.has(addonKey(addon)))
      continue;
    errors.push({
      code: "NATIVE_ADDON_VERSION_NOT_INSTALLED",
      message: `No execution realm contains ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
}
function assertArtifactValidation(report) {
  if (report.ok)
    return;
  throw new Error(`Assistant artifact validation failed:
${report.errors.map((issue) => `- [${issue.code}] ${issue.message}`).join(`
`)}`);
}
async function resolveRealmPackages(projectRoot, roots, singletonPackages) {
  const queue = roots.map((name) => ({ name, from: projectRoot }));
  const visited = new Set;
  const packages = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current)
      break;
    const manifestPath = await resolvePackageManifest(current.name, current.from);
    const physicalManifest = await realpath(manifestPath);
    if (visited.has(physicalManifest))
      continue;
    visited.add(physicalManifest);
    const manifest = await readManifest(physicalManifest);
    if (!manifest.name || !manifest.version) {
      throw new Error(`Package manifest omitted name/version: ${physicalManifest}`);
    }
    const packagePath = path4.dirname(physicalManifest);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      packagePath,
      singleton: singletonPackages.has(manifest.name) || manifest.addon === true
    });
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies
    };
    for (const name of Object.keys(dependencies).sort()) {
      try {
        await resolvePackageManifest(name, packagePath);
        queue.push({ name, from: packagePath });
      } catch {
        if (manifest.optionalDependencies?.[name] === undefined)
          throw new Error(`Unable to resolve ${name} required by ${manifest.name}@${manifest.version}`);
      }
    }
  }
  return packages.sort(comparePackageInstances);
}
async function resolvePackageManifest(name, from) {
  let directory = path4.resolve(from);
  while (true) {
    const candidate = path4.join(directory, "node_modules", ...name.split("/"), "package.json");
    try {
      const info = await stat(candidate);
      if (info.isFile())
        return candidate;
    } catch {}
    const parent = path4.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  throw new Error(`Unable to resolve package ${name} from ${from}`);
}
async function readManifest(manifestPath) {
  const parsed = JSON.parse(await readFile4(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed package manifest: ${manifestPath}`);
  }
  return parsed;
}
function validateRealmDuplicates(realms, errors) {
  for (const realm of realms) {
    const versions = new Map;
    for (const instance of realm.packages ?? []) {
      if (!instance.singleton)
        continue;
      const current = versions.get(instance.name) ?? new Set;
      current.add(instance.version);
      versions.set(instance.name, current);
    }
    for (const [name, found] of versions) {
      if (found.size < 2)
        continue;
      errors.push({
        code: "DUPLICATE_SINGLETON_VERSION",
        message: `${realm.name} contains ${name} at versions ${[...found].sort().join(", ")}`,
        realm: realm.name,
        packageName: name
      });
    }
  }
}
function validateAddonUnion(options, errors) {
  const declared = [
    ...options.sdkAddons,
    ...options.workers.flatMap((worker) => worker.nativeAddons)
  ];
  const versions = new Map;
  for (const addon of declared) {
    const current = versions.get(addon.name) ?? new Set;
    current.add(addon.version);
    versions.set(addon.name, current);
  }
  for (const [name, found] of versions) {
    if (found.size < 2)
      continue;
    errors.push({
      code: "CONFLICTING_NATIVE_ADDON_VERSION",
      message: `${name} is required at versions ${[...found].sort().join(", ")}`,
      packageName: name
    });
  }
  const expected = uniqueAddons(declared);
  const merged = uniqueAddons(options.mergedAddons);
  const expectedKeys = new Set(expected.map(addonKey));
  const mergedKeys = new Set(merged.map(addonKey));
  for (const addon of expected) {
    if (mergedKeys.has(addonKey(addon)))
      continue;
    errors.push({
      code: "MISSING_MERGED_ADDON",
      message: `Merged linker manifest omits ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  for (const addon of merged) {
    if (expectedKeys.has(addonKey(addon)))
      continue;
    errors.push({
      code: "UNDECLARED_MERGED_ADDON",
      message: `Merged linker manifest includes undeclared ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  return expected;
}
function validateStagedResources(resources, expected, required, errors) {
  const staged = new Set;
  for (const resource of resources) {
    const identity = identifyNativeResource(resource, expected);
    if (!identity)
      continue;
    staged.add(addonKey(identity));
  }
  const expectedKeys = new Set(expected.map(addonKey));
  for (const addon of required) {
    if (staged.has(addonKey(addon)))
      continue;
    errors.push({
      code: "MISSING_NATIVE_PREBUILD",
      message: `No staged native resource found for ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  for (const key of staged) {
    if (expectedKeys.has(key))
      continue;
    errors.push({
      code: "UNDECLARED_STAGED_ADDON",
      message: `Staged native resource is not declared by a worker: ${key}`
    });
  }
}
function identifyNativeResource(resource, expected) {
  const normalized = resource.replaceAll("\\", "/");
  for (const addon of expected) {
    const encoded2 = addon.name.startsWith("@") ? addon.name.slice(1).replace("/", "__") : addon.name;
    if (containsResourceIdentity(normalized, encoded2) && (normalized.includes(addon.version) || !/\d+\.\d+\.\d+/.test(normalized))) {
      return addon;
    }
  }
  const encoded = normalized.match(/(?:^|\/)(?:lib)?([a-z0-9-]+__[a-z0-9-]+)(?:\.(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?))?\.(?:so|bare|node|framework)(?:\/|$)/i);
  const identity = encoded?.[1];
  if (identity) {
    const separator = identity.indexOf("__");
    const scope = identity.slice(0, separator);
    const name = identity.slice(separator + 2);
    return {
      name: `@${scope}/${name}`,
      version: encoded[2] ?? "unknown"
    };
  }
  return null;
}
function containsResourceIdentity(resource, encodedName) {
  const candidates = [encodedName, `lib${encodedName}`];
  return resource.split("/").some((segment) => candidates.some((candidate) => segment === candidate || segment.startsWith(`${candidate}.`)));
}
function uniqueAddons(addons) {
  return [...new Map(addons.map((addon) => [addonKey(addon), addon])).values()].sort((left, right) => addonKey(left).localeCompare(addonKey(right)));
}
function addonKey(addon) {
  return `${addon.name}@${addon.version}`;
}
function comparePackageInstances(left, right) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath);
}

// lib/packaging/barekit-linker.ts
import { readFile as readFile5, writeFile as writeFile2 } from "node:fs/promises";
import { createRequire as createRequire2 } from "node:module";
import path5 from "node:path";
var ACCELERATOR_FILTER_SENTINEL = "// [QVAC-ASSISTANT-ACCELERATORS]";
async function pinBareKitLinkerProjectRoot(projectRoot, accelerators = null) {
  const require2 = createRequire2(path5.join(projectRoot, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require2.resolve("react-native-bare-kit/package.json");
  } catch {
    return;
  }
  const packageRoot = path5.dirname(packageJsonPath);
  for (const relativePath of ["android/link.mjs", "ios/link.mjs"]) {
    const linkerPath = path5.join(packageRoot, relativePath);
    const source = await readFileStrict2(linkerPath, `BareKit linker ${relativePath}`);
    const pattern = /^const projectRoot = .+$/m;
    if (!pattern.test(source)) {
      throw new Error(`BareKit linker project-root declaration was not found: ${linkerPath}`);
    }
    const pinned = source.replace(pattern, `const projectRoot = ${JSON.stringify(projectRoot)}`);
    const filtered = relativePath === "android/link.mjs" ? appendAcceleratorFilter(pinned, accelerators) : pinned;
    await writeFile2(linkerPath, filtered);
  }
}
function appendAcceleratorFilter(source, accelerators) {
  const stripped = removeExistingFilter(source);
  if (accelerators === null)
    return stripped;
  const kept = accelerators.filter((entry) => entry !== "cpu");
  const removable = ASSISTANT_INFERENCE_ACCELERATORS.filter((entry) => entry !== "cpu" && !kept.includes(entry));
  return `${stripped}${renderAcceleratorFilter(removable, ["cpu", ...kept])}`;
}
function removeExistingFilter(source) {
  const index = source.indexOf(ACCELERATOR_FILTER_SENTINEL);
  return `${(index === -1 ? source : source.slice(0, index)).trimEnd()}
`;
}
function renderAcceleratorFilter(removableAccelerators, keptAccelerators) {
  return `
${ACCELERATOR_FILTER_SENTINEL} Generated by @qvac/assistant/expo-plugin from
// qvac.assistant.yaml. The app declared which GPU backends it ships; ggml's
// CPU backend is its base and is always kept, as is any backend neither list
// names — a backend introduced after this build tooling is reported, not
// deleted.
const removableAccelerators = new Set(${JSON.stringify(removableAccelerators)})
const keptAccelerators = new Set(${JSON.stringify(keptAccelerators)})
const acceleratorPattern = /-ggml-([a-z0-9]+)(?:[-_.]|\\.so(?:\\.[0-9]+(?:\\.[0-9]+)*)?$)/
// Mirrors the shared-object test in bare-link's android platform handler,
// which also copies SONAME-versioned libraries such as libfoo.so.1.2.3. A
// narrower test here would skip such a file before it could be classified,
// which is the one way an undeclared backend could ship unreported.
const sharedObjectPattern = /\\.so(?:\\.[0-9]+(?:\\.[0-9]+)*)?$/
const unrecognisedBackends = new Set()

async function pruneUndeclaredAccelerators (directory) {
  let entries
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await pruneUndeclaredAccelerators(entryPath)
      continue
    }
    if (!sharedObjectPattern.test(entry.name)) continue
    const match = acceleratorPattern.exec(entry.name)
    if (!match) continue
    if (removableAccelerators.has(match[1])) {
      await fs.promises.rm(entryPath)
      console.log('[QVAC] Dropped undeclared ' + match[1] + ' backend', entry.name)
      continue
    }
    if (!keptAccelerators.has(match[1])) unrecognisedBackends.add(match[1])
  }
}

await pruneUndeclaredAccelerators(addonsDir)

if (unrecognisedBackends.size > 0) {
  console.log(
    '[QVAC] Kept unrecognised ggml backend(s): ' +
      [...unrecognisedBackends].sort().join(', ') +
      '. Declare them in qvac.assistant.yaml to control whether they ship.'
  )
}
`;
}
async function readFileStrict2(filePath, label) {
  try {
    return await readFile5(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }
}

// lib/packaging/sdk-bundle-inventory.ts
import Bundle from "bare-bundle";
import { access as access4, readFile as readFile6 } from "node:fs/promises";
async function readSdkBundlePackages(bundlePath) {
  try {
    await access4(bundlePath);
  } catch {
    return null;
  }
  const source = await readFile6(bundlePath);
  const text = source.toString("utf8");
  const prefix = "module.exports = ";
  const bundle = text.startsWith(prefix) ? decodeExportedBundle(text, prefix, bundlePath) : decodeBundle(source, bundlePath);
  const files = Reflect.get(bundle, "files");
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`SDK bundle omitted file inventory: ${bundlePath}`);
  }
  const packages = [];
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith("/package.json") || typeof file !== "object" || file === null) {
      continue;
    }
    const data = Reflect.get(file, "_data");
    if (!(data instanceof Uint8Array))
      continue;
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    if (!isObject2(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
      continue;
    }
    packages.push({
      name: parsed.name,
      version: parsed.version,
      packagePath,
      singleton: parsed.addon === true
    });
  }
  if (packages.length === 0) {
    throw new Error(`SDK bundle contained no package manifests: ${bundlePath}`);
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath));
}
function decodeExportedBundle(source, prefix, bundlePath) {
  const literal = source.slice(prefix.length).trim().replace(/;$/, "");
  const encoded = JSON.parse(literal);
  if (typeof encoded !== "string") {
    throw new Error(`SDK bundle wrapper did not export a string: ${bundlePath}`);
  }
  return Bundle.from(encoded);
}
function decodeBundle(data, bundlePath) {
  const from = Reflect.get(Bundle, "from");
  if (typeof from !== "function") {
    throw new Error("bare-bundle did not expose Bundle.from");
  }
  const decoded = Reflect.apply(from, Bundle, [data]);
  if (!(decoded instanceof Bundle)) {
    throw new Error(`Unable to decode SDK bundle: ${bundlePath}`);
  }
  return decoded;
}
function isObject2(value) {
  return typeof value === "object" && value !== null;
}

// lib/packaging/stack-manifest.ts
var ASSISTANT_PLUGIN_VERSION = readAssistantPackageVersion();
async function writeAssistantStackArtifacts(projectRoot, builtWorkers, pinLinkerRoot = false) {
  const qvacDirectory = path6.join(projectRoot, "qvac");
  const sdkManifestPath = path6.join(qvacDirectory, "addons.manifest.json");
  const stackManifestPath = path6.join(qvacDirectory, "assistant-stack.manifest.json");
  const sdkManifest = await readSdkManifest(sdkManifestPath);
  const sdkSourceAddons = await resolveSdkSourceAddons(projectRoot, sdkManifest);
  const mergedAddons = mergeAddonInventories(sdkSourceAddons, builtWorkers.sync.nativeAddons, builtWorkers.harness.nativeAddons);
  const assistantProvenance = {
    schemaVersion: ASSISTANT_MANIFEST_PROVENANCE_VERSION,
    sourcePlugin: ASSISTANT_PLUGIN_ID,
    sourcePluginVersion: ASSISTANT_PLUGIN_VERSION,
    sdkSourceAddons
  };
  await mkdir(qvacDirectory, { recursive: true });
  await writeFile3(sdkManifestPath, `${JSON.stringify({
    version: sdkManifest.version,
    bundleId: sdkManifest.bundleId,
    addons: mergedAddons.map((entry) => entry.name),
    assistantProvenance
  }, null, 2)}
`);
  const packageVersions = await readPackageVersions(projectRoot);
  const sdkBundlePackages = await readSdkBundlePackages(path6.join(qvacDirectory, "worker.bundle.js"));
  const appConfig = await resolveAssistantAppConfig(projectRoot);
  const stackManifest = {
    manifestVersion: ASSISTANT_STACK_MANIFEST_VERSION,
    pluginExecutionOrder: [...PLUGIN_EXECUTION_ORDER],
    requiredHosts: [...REQUIRED_MOBILE_HOSTS],
    packageVersions,
    bundles: {
      sync: builtWorkers.sync.bundleId,
      harness: builtWorkers.harness.bundleId,
      sdk: sdkManifest.bundleId
    },
    sdkSource: {
      manifestVersion: sdkManifest.version,
      bundleId: sdkManifest.bundleId,
      addons: sdkSourceAddons
    },
    workers: {
      sync: {
        contract: builtWorkers.sync.contract,
        protocolVersion: builtWorkers.sync.protocolVersion,
        hosts: builtWorkers.sync.hosts,
        nativeAddons: builtWorkers.sync.nativeAddons
      },
      harness: {
        contract: builtWorkers.harness.contract,
        protocolVersion: builtWorkers.harness.protocolVersion,
        hosts: builtWorkers.harness.hosts,
        nativeAddons: builtWorkers.harness.nativeAddons
      }
    },
    mergedAddons,
    sdkPluginSelection: appConfig === null || appConfig.capabilities === null || appConfig.plugins === null ? null : {
      configPath: path6.relative(projectRoot, appConfig.configPath),
      capabilities: appConfig.capabilities,
      plugins: appConfig.plugins
    },
    acceleratorSelection: appConfig === null || appConfig.accelerators === null ? null : {
      configPath: path6.relative(projectRoot, appConfig.configPath),
      accelerators: appConfig.accelerators
    },
    realms: [
      {
        name: "host",
        roots: ["@qvac/assistant"],
        packages: [
          {
            name: "@qvac/assistant",
            version: packageVersions.assistant,
            packagePath: resolveAssistantPackageJsonPath(),
            singleton: false
          }
        ]
      },
      {
        name: "sync-worker",
        roots: ["@qvac/sync"],
        packages: createRecordedRealmPackages("@qvac/sync", packageVersions.sync, builtWorkers.sync.bundleId, builtWorkers.sync.packages, builtWorkers.sync.nativeAddons)
      },
      {
        name: "harness-worker",
        roots: ["@qvac/harness"],
        packages: createRecordedRealmPackages("@qvac/harness", packageVersions.harness, builtWorkers.harness.bundleId, builtWorkers.harness.packages, builtWorkers.harness.nativeAddons)
      },
      {
        name: "sdk-worker",
        roots: ["@qvac/sdk"],
        packages: sdkBundlePackages ?? [
          {
            name: "@qvac/sdk",
            version: packageVersions.sdk,
            packagePath: `sdk-bundle:${sdkManifest.bundleId ?? "unknown"}/@qvac/sdk`,
            singleton: false
          },
          ...sdkSourceAddons.map((addon) => ({
            ...addon,
            packagePath: `sdk-bundle:${sdkManifest.bundleId ?? "unknown"}/${addon.name}`,
            singleton: true
          }))
        ]
      }
    ],
    singletonPackages: [
      "react-native-bare-kit",
      ...mergedAddons.map((addon) => addon.name)
    ].sort()
  };
  const validation = await validateArtifacts({
    projectRoot,
    realms: stackManifest.realms,
    singletonPackages: stackManifest.singletonPackages,
    sdkAddons: stackManifest.sdkSource.addons,
    workers: [
      {
        name: "sync",
        nativeAddons: stackManifest.workers.sync.nativeAddons
      },
      {
        name: "harness",
        nativeAddons: stackManifest.workers.harness.nativeAddons
      }
    ],
    mergedAddons: stackManifest.mergedAddons
  });
  assertArtifactValidation(validation);
  await writeFile3(stackManifestPath, `${JSON.stringify(stackManifest, null, 2)}
`);
  await writeFile3(path6.join(qvacDirectory, "assistant-stack.validation.json"), `${JSON.stringify(validation, null, 2)}
`);
  if (pinLinkerRoot) {
    await pinBareKitLinkerProjectRoot(projectRoot, appConfig?.accelerators ?? null);
  }
}
async function readSdkManifest(sdkManifestPath) {
  let source = "";
  try {
    source = await readFileStrict(sdkManifestPath, "SDK addons manifest");
  } catch {
    throw new Error(`Missing SDK addons manifest: ${sdkManifestPath}. ` + "Run @qvac/sdk/expo-plugin before assistant manifest merge.");
  }
  const parsed = parseJson(source, sdkManifestPath, "SDK addons manifest");
  if (!isSdkManifest(parsed)) {
    throw new Error(`Malformed SDK addons manifest: ${sdkManifestPath}`);
  }
  return parsed;
}
async function resolveSdkSourceAddons(projectRoot, sdkManifest) {
  if (isAssistantManifestProvenance(sdkManifest.assistantProvenance)) {
    return [...sdkManifest.assistantProvenance.sdkSourceAddons].sort(compareAddons);
  }
  return resolveAddonsByAncestor(projectRoot, sdkManifest.addons);
}
function createRecordedRealmPackages(rootName, rootVersion, bundleId, bundledPackages, nativeAddons) {
  const packages = [
    ...bundledPackages ?? [],
    {
      name: rootName,
      version: rootVersion,
      packagePath: `bundle:${bundleId}/${rootName}`,
      singleton: false
    }
  ];
  const recorded = new Set(packages.map((entry) => `${entry.name}@${entry.version}`));
  for (const addon of nativeAddons) {
    const key = `${addon.name}@${addon.version}`;
    if (recorded.has(key))
      continue;
    packages.push({
      ...addon,
      packagePath: `bundle:${bundleId}/${addon.name}`,
      singleton: true
    });
    recorded.add(key);
  }
  return packages;
}
function isSdkManifest(value) {
  if (!isObject(value))
    return false;
  const version = value.version;
  const bundleId = value.bundleId;
  const addons = value.addons;
  return typeof version === "number" && Number.isFinite(version) && (bundleId === null || typeof bundleId === "string") && Array.isArray(addons) && addons.every((entry) => typeof entry === "string");
}
function isVersionedAddon(value) {
  return isObject(value) && typeof value.name === "string" && typeof value.version === "string";
}
function isAssistantManifestProvenance(value) {
  return isObject(value) && value.schemaVersion === ASSISTANT_MANIFEST_PROVENANCE_VERSION && value.sourcePlugin === ASSISTANT_PLUGIN_ID && typeof value.sourcePluginVersion === "string" && Array.isArray(value.sdkSourceAddons) && value.sdkSourceAddons.every(isVersionedAddon);
}

// lib/expo/finalize.ts
async function finalizeAssistantStack(projectRoot, options = {}) {
  const builtWorkers = await readPackageContributions(projectRoot, {
    syncContribution: options.syncContribution,
    harnessContribution: options.harnessContribution
  });
  await writeAssistantStackArtifacts(projectRoot, builtWorkers, options.pinLinkerRoot === true);
}

// lib/expo/plugin.ts
var ASSISTANT_PLUGIN_VERSION2 = readAssistantPackageVersion();
async function composeAssistantStack(options) {
  await finalizeAssistantStack(options.projectRoot, {
    pinLinkerRoot: options.pinLinkerRoot === true,
    syncContribution: options.syncContribution,
    harnessContribution: options.harnessContribution
  });
}
function createAssistantExpoPlugin(options = {}) {
  const sdkPlugin = options.sdkPlugin ?? sdkExpoPlugin;
  const syncPlugin = options.syncPlugin ?? createSyncExpoPlugin({
    mode: "contributor",
    build: options.syncBuild
  });
  const harnessPlugin = options.harnessPlugin ?? createHarnessExpoPlugin({
    mode: "contributor",
    build: options.harnessBuild
  });
  const finalizeCache = new Map;
  const appConfigCache = new Map;
  const runOncePlugin = createRunOncePlugin(withAssistantExpoPlugin, ASSISTANT_PLUGIN_ID, ASSISTANT_PLUGIN_VERSION2);
  return runOncePlugin;
  function withAssistantExpoPlugin(config) {
    assertNoDuplicatePluginRegistration(config.plugins, {
      sdkPlugin,
      syncPlugin,
      harnessPlugin,
      assistantRunOncePlugin: runOncePlugin,
      assistantPlugin: withAssistantExpoPlugin
    });
    return withPlugins(config, [
      withRunOnceFinalizePlugin,
      sdkPlugin,
      harnessPlugin,
      syncPlugin,
      withRunOnceAppConfigPlugin
    ]);
  }
  function withRunOnceAppConfigPlugin(config) {
    return withRunOnce(config, {
      name: ASSISTANT_APP_CONFIG_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION2,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          "android",
          async (context) => {
            await resolveAppConfigOnce(context);
            return context;
          }
        ]);
        configValue = withDangerousMod(configValue, [
          "ios",
          async (context) => {
            await resolveAppConfigOnce(context);
            return context;
          }
        ]);
        return configValue;
      }
    });
  }
  function withRunOnceFinalizePlugin(config) {
    return withRunOnce(config, {
      name: ASSISTANT_FINALIZE_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION2,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          "android",
          async (context) => {
            await finalizeOnce(context);
            return context;
          }
        ]);
        configValue = withDangerousMod(configValue, [
          "ios",
          async (context) => {
            await finalizeOnce(context);
            return context;
          }
        ]);
        return configValue;
      }
    });
  }
  async function resolveAppConfigOnce(context) {
    const projectRoot = readProjectRoot(context);
    const existing = appConfigCache.get(projectRoot);
    if (existing)
      return existing;
    const work = propagateAppConfig(projectRoot).catch((error) => {
      appConfigCache.delete(projectRoot);
      throw error;
    });
    appConfigCache.set(projectRoot, work);
    return work;
  }
  async function finalizeOnce(context) {
    const projectRoot = readProjectRoot(context);
    const existing = finalizeCache.get(projectRoot);
    if (existing)
      return existing;
    const work = finalizeAssistantStack(projectRoot, { pinLinkerRoot: true }).catch((error) => {
      finalizeCache.delete(projectRoot);
      throw error;
    });
    finalizeCache.set(projectRoot, work);
    return work;
  }
}
async function propagateAppConfig(projectRoot) {
  const resolved = await resolveAssistantAppConfig(projectRoot);
  if (resolved === null) {
    console.log("▸ QVAC assistant: no qvac.assistant.yaml, keeping every built-in SDK capability");
    return;
  }
  const generatedPath = await writeGeneratedSdkConfig(projectRoot, resolved);
  const selection = resolved.capabilities === null ? "every built-in capability" : `capabilities ${resolved.capabilities.join(", ")}`;
  console.log(`▸ QVAC assistant: ${path7.basename(resolved.configPath)} selected ${selection}; ` + `wrote ${path7.basename(generatedPath)}`);
}
function readProjectRoot(context) {
  const projectRoot = context.modRequest.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("Expo plugin modRequest.projectRoot was missing");
  }
  return projectRoot;
}
function assertNoDuplicatePluginRegistration(plugins, options) {
  const entries = plugins ?? [];
  if (entries.some((entry) => isMatchingPluginEntry(entry, SDK_PLUGIN_ID, options.sdkPlugin))) {
    throw new Error("Duplicate SDK plugin registration detected. " + "Use only @qvac/assistant/expo-plugin and remove @qvac/sdk/expo-plugin from app config.");
  }
  if (entries.some((entry) => isMatchingPluginEntry(entry, SYNC_PLUGIN_ID, options.syncPlugin))) {
    throw new Error("Duplicate Sync plugin registration detected. " + "Use only @qvac/assistant/expo-plugin and remove @qvac/sync/expo-plugin from app config.");
  }
  if (entries.some((entry) => isMatchingPluginEntry(entry, HARNESS_PLUGIN_ID, options.harnessPlugin))) {
    throw new Error("Duplicate Harness plugin registration detected. " + "Use only @qvac/assistant/expo-plugin and remove @qvac/harness/expo-plugin from app config.");
  }
  const assistantRegistrations = entries.filter((entry) => isMatchingAssistantPluginEntry(entry, options.assistantRunOncePlugin, options.assistantPlugin));
  if (assistantRegistrations.length > 1) {
    throw new Error("Duplicate plugin registration detected for @qvac/assistant/expo-plugin.");
  }
}
function isMatchingAssistantPluginEntry(entry, assistantRunOncePlugin, assistantPlugin) {
  if (isMatchingPluginEntry(entry, ASSISTANT_PLUGIN_ID, assistantRunOncePlugin))
    return true;
  if (typeof entry === "function")
    return entry === assistantPlugin;
  if (!Array.isArray(entry))
    return false;
  const [plugin] = entry;
  return typeof plugin === "function" && plugin === assistantPlugin;
}
function isMatchingPluginEntry(entry, pluginId, pluginFunction) {
  if (typeof entry === "string") {
    return entry === pluginId || entry.endsWith(pluginId);
  }
  if (typeof entry === "function")
    return entry === pluginFunction;
  if (!Array.isArray(entry) || entry.length === 0)
    return false;
  const [plugin] = entry;
  if (typeof plugin === "string") {
    return plugin === pluginId || plugin.endsWith(pluginId);
  }
  return typeof plugin === "function" && plugin === pluginFunction;
}

// expo-plugin.ts
var expo_plugin_default = createAssistantExpoPlugin();
export {
  readPackageContributions,
  finalizeAssistantStack,
  expo_plugin_default as default,
  createAssistantExpoPlugin,
  composeAssistantStack
};
