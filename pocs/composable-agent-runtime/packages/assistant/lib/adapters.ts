import {
  createHarness,
  type CreateHarnessOptions,
  type HarnessRuntime
} from '@qvac/harness'
import {
  createSync,
  type CreateSyncOptions
} from '@qvac/sync'
import type {
  AssistantHarnessComponent,
  AssistantInference,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './contracts.ts'
import { handshakeFrom } from './handshakes.ts'

export async function startSyncComponent(
  options: CreateSyncOptions
): Promise<AssistantSyncComponent> {
  const sync = createSync(options)
  try {
    await sync.ready()
    const identity = await sync.runtime.describe()
    return {
      handshake: handshakeFrom(identity),
      state: sync,
      exited: sync.exited,
      close: () => sync.close(),
      suspend: () => sync.lifecycle.suspend(),
      resume: () => sync.lifecycle.resume(),
      inspect: () => ({ ...identity })
    }
  } catch (error) {
    await sync.close().catch(() => {})
    throw error
  }
}

export interface StartHarnessOptions {
  readonly inference: AssistantInference
  readonly logging?: CreateAssistantOptions['logging']
  readonly workers?: CreateAssistantOptions['workers']
  readonly host?: CreateAssistantOptions['host']
  /** Overridden by tests so forwarding can be asserted without a Bare worker. */
  readonly createHarness?: (options: CreateHarnessOptions) => HarnessRuntime
}

export async function startHarnessComponent(
  state: AssistantSyncComponent['state'],
  {
    inference,
    logging,
    workers,
    host,
    createHarness: create = createHarness
  }: StartHarnessOptions
): Promise<AssistantHarnessComponent> {
  const harness: HarnessRuntime = create({
    state,
    inference: inference.kind,
    logging,
    ...(workers ? { workers } : {}),
    ...(host ? { host } : {})
  })
  try {
    await harness.ready()
    const identity = await harness.runtime.describe()
    return {
      handshake: handshakeFrom(identity),
      harness,
      exited: harness.exited,
      close: () => harness.close(),
      suspend: () => harness.lifecycle.suspend(),
      resume: () => harness.lifecycle.resume(),
      inspect: () => ({ ...identity })
    }
  } catch (error) {
    await harness.close().catch(() => {})
    throw error
  }
}
