import { useEffect, useRef, useState } from 'react'
import { File, Paths } from 'expo-file-system'
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native'
import { formatTurnWorkId, type CodeSessionSummary, type CodeTurnView } from '@qvac-poc/qvac-code-shared'
import type { CodeExecutorRecord } from '@qvac-poc/qvac-code-shared/store'
import { parsePairingUri } from './src/pairing-uri.ts'
import { readDevBootstrap } from './src/dev-bootstrap.ts'
import {
  mobileSyncMarkerUri,
  mobileSyncStoragePath
} from './src/storage-path.ts'
import {
  createSessionController,
  type SessionControllerSnapshot
} from './src/session-controller.ts'
import {
  createApprovalController,
  type ApprovalSheetSnapshot
} from './src/approval-controller.ts'
import {
  ConnectionPanel,
  ExecutorList,
  SessionComposer,
  SessionListFeed
} from './src/session-list.screen.tsx'
import { TranscriptHeader, TranscriptBlocks, TranscriptComposer } from './src/transcript.screen.tsx'
import { ApprovalSheet } from './src/approval-sheet.tsx'
import { colors, fontWeight } from './src/theme.ts'

const EXECUTOR_REFRESH_MS = 5_000

type Navigation =
  | { readonly screen: 'sessions' }
  | { readonly screen: 'transcript'; readonly sessionId: string; readonly turnWorkId: string }

export default function App() {
  const [syncSnapshot, setSyncSnapshot] = useState<SessionControllerSnapshot>({
    state: 'idle',
    error: null,
    deviceCount: 0
  })
  const [sessionController] = useState(() =>
    createSessionController({
      storagePath: mobileSyncStoragePath(Paths.document.uri),
      // EXPO_PUBLIC_* vars are inlined at build time and would otherwise
      // ship in a release bundle too. __DEV__ is a Metro/RN build-time
      // constant, not a runtime read of the same env var, so a release
      // build never even evaluates the override -- see dev-bootstrap.ts's
      // own comment on why this must never become a real configuration key.
      bootstrap: __DEV__
        ? readDevBootstrap({
            EXPO_PUBLIC_QVAC_BOOTSTRAP: process.env.EXPO_PUBLIC_QVAC_BOOTSTRAP
          })
        : undefined,
      hasPersistentPairing: () =>
        new File(mobileSyncMarkerUri(Paths.document.uri)).exists,
      onState: setSyncSnapshot
    })
  )
  const [navigation, setNavigation] = useState<Navigation>({ screen: 'sessions' })
  const [approvalSnapshot, setApprovalSnapshot] = useState<ApprovalSheetSnapshot>({
    kind: 'hidden'
  })
  const approvalControllerRef = useRef<ReturnType<typeof createApprovalController> | null>(null)

  const [pairingUri, setPairingUri] = useState('')
  const [pairingError, setPairingError] = useState<string | null>(null)

  const [sessions, setSessions] = useState<readonly CodeSessionSummary[]>([])
  const [executors, setExecutors] = useState<readonly CodeExecutorRecord[]>([])
  const [selectedExecutorId, setSelectedExecutorId] = useState<string | null>(null)

  const [sessionTitle, setSessionTitle] = useState('')
  const [projectLabel, setProjectLabel] = useState('')
  const [model, setModel] = useState('')
  const [firstPrompt, setFirstPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [turnView, setTurnView] = useState<CodeTurnView | null>(null)
  const [nextPrompt, setNextPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    // A failed reconnect is already on screen: connect() folds the reason
    // into its own snapshot as `state: 'error'` before rethrowing, and
    // ConnectionPanel renders it. Logged rather than dropped so the cause
    // chain survives.
    void sessionController.reconnect().catch(logFailure('reconnect on mount'))
    return () => {
      // Unmount: there is no snapshot left for anyone to observe, so a
      // teardown failure has nowhere to go but the log.
      void sessionController.close().catch(logFailure('close on unmount'))
    }
  }, [sessionController])

  useEffect(() => {
    if (syncSnapshot.state !== 'ready') {
      approvalControllerRef.current?.stop()
      approvalControllerRef.current = null
      setApprovalSnapshot({ kind: 'hidden' })
      return
    }
    const store = sessionController.store()
    if (!store) return
    const controller = createApprovalController({
      store,
      deviceRef: sessionController.deviceRef,
      onState: setApprovalSnapshot
    })
    approvalControllerRef.current = controller
    return () => {
      controller.stop()
      approvalControllerRef.current = null
    }
  }, [sessionController, syncSnapshot.state])

  useEffect(() => {
    if (syncSnapshot.state !== 'ready') {
      setSessions([])
      return
    }
    // syncSnapshot.state is the rendered snapshot, not the controller's live
    // state -- a disconnect landing in the gap between this render and the
    // effect flushing would make watchSessions() throw synchronously here.
    // The controller's own onState already schedules the re-render that
    // corrects syncSnapshot, so this is a log-and-skip, not a real failure.
    try {
      return sessionController.watchSessions(setSessions)
    } catch (error) {
      logFailure('subscribing to sessions')(error)
      return
    }
  }, [sessionController, syncSnapshot.state])

  useEffect(() => {
    if (syncSnapshot.state !== 'ready') {
      setExecutors([])
      return
    }
    // Only the sessions screen shows this list, so polling it from the
    // transcript screen is a mesh query every tick for nothing on screen.
    if (navigation.screen !== 'sessions') return
    let cancelled = false
    async function load() {
      try {
        const list = await sessionController.listExecutors()
        if (!cancelled) setExecutors(list)
      } catch (error) {
        // A transient listing failure leaves the previous list on screen and
        // the next tick retries, so this is not surfaced -- but a listing
        // that fails every tick would otherwise look like "no executors".
        logFailure('listing executors')(error)
      }
    }
    void load()
    const interval = setInterval(() => void load(), EXECUTOR_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionController, syncSnapshot.state, navigation.screen])

  useEffect(() => {
    setTurnView(null)
    if (navigation.screen !== 'transcript') return
    // `syncSnapshot.state` is a dependency, not just a guard: without it a
    // drop-and-reconnect while this screen is open never re-subscribes --
    // teardown stopped the old watch and nothing else re-runs this effect,
    // so the transcript froze until the user navigated away and back.
    if (syncSnapshot.state !== 'ready') return
    // See the same guard in the sessions-watch effect above: syncSnapshot.state
    // is the rendered snapshot, and the controller can have moved on by the
    // time this runs, making watchTurn() throw synchronously.
    try {
      return sessionController.watchTurn(navigation.turnWorkId, setTurnView)
    } catch (error) {
      logFailure('subscribing to the transcript')(error)
      return
    }
  }, [sessionController, navigation, syncSnapshot.state])

  async function pair() {
    const candidate = pairingUri.trim()
    try {
      parsePairingUri(candidate)
      setPairingError(null)
      await sessionController.connect(candidate)
    } catch (error) {
      setPairingError(errorMessage(error))
      return
    }
    // A superseded connect() (raced by another connect()/reconnect()) returns
    // without throwing, so this call resolving is not proof this attempt is
    // the one that landed -- checking the live snapshot before writing the
    // marker avoids recording "paired" for an attempt that was abandoned.
    if (sessionController.snapshot().state !== 'ready') return
    // The mesh session is live either way -- this marker only decides whether
    // the next launch auto-reconnects. A failure here must not read as
    // "pairing failed", and it cannot be shown on this panel at all:
    // ConnectionPanel renders pairingError only while still unpaired. So it
    // goes to the log rather than into state nothing will ever display.
    try {
      new File(mobileSyncMarkerUri(Paths.document.uri)).write('paired')
    } catch (error) {
      logFailure('persisting the pairing marker')(error)
    }
  }

  async function reconnect() {
    setPairingError(null)
    try {
      await sessionController.reconnect()
    } catch (error) {
      setPairingError(errorMessage(error))
    }
  }

  async function cancelPairing() {
    setPairingError(null)
    try {
      await sessionController.disconnect()
    } catch (error) {
      setPairingError(errorMessage(error))
    }
  }

  async function createSession() {
    if (!selectedExecutorId) return
    setCreating(true)
    setCreateError(null)
    try {
      const outcome = await sessionController.createSession({
        title: sessionTitle.trim(),
        prompt: firstPrompt.trim(),
        executorId: selectedExecutorId,
        projectLabel: projectLabel.trim(),
        model: model.trim()
      })
      if (outcome.kind === 'lost') {
        setCreateError(
          `The ${outcome.stage} write did not land as sent (${outcome.reason}). Try again.`
        )
        return
      }
      setSessionTitle('')
      setProjectLabel('')
      setModel('')
      setFirstPrompt('')
      setNavigation({
        screen: 'transcript',
        sessionId: outcome.sessionId,
        turnWorkId: outcome.turnWorkId
      })
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  async function openSession(sessionId: string) {
    const store = sessionController.store()
    if (!store) return
    setCreateError(null)
    try {
      const nextSeq = await store.nextTurnSeq(sessionId)
      if (nextSeq <= 0) return
      setNavigation({
        screen: 'transcript',
        sessionId,
        turnWorkId: formatTurnWorkId({ sessionId, seq: nextSeq - 1 })
      })
    } catch (error) {
      // Without this the tap just did nothing and the rejection vanished.
      setCreateError(`Could not open session ${sessionId}: ${errorMessage(error)}`)
    }
  }

  async function submitNextTurn() {
    if (navigation.screen !== 'transcript') return
    const executorId = turnView?.claimedBy
    if (!executorId) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await sessionController.submitTurn({
        sessionId: navigation.sessionId,
        prompt: nextPrompt.trim(),
        executorId
      })
      setNextPrompt('')
      setNavigation({
        screen: 'transcript',
        sessionId: navigation.sessionId,
        turnWorkId: result.turnWorkId
      })
    } catch (error) {
      setSubmitError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelCurrentTurn() {
    if (navigation.screen !== 'transcript') return
    try {
      await sessionController.cancelTurn(navigation.turnWorkId)
    } catch (error) {
      setSubmitError(errorMessage(error))
    }
  }

  async function resolveApproval(approved: boolean) {
    try {
      await approvalControllerRef.current?.resolve(approved)
    } catch (error) {
      // approval-controller.ts folds every *write* failure into its own
      // snapshot, so the sheet shows those itself. What still throws is its
      // two precondition guards -- a malformed turn work id, or a device ref
      // that vanished mid-tap. Neither has a place on the sheet, and both
      // mean the tap did nothing, so they must not be dropped silently.
      logFailure('resolving an approval')(error)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      {navigation.screen === 'sessions' ? (
        <SessionsScreen
          syncSnapshot={syncSnapshot}
          pairingUri={pairingUri}
          pairingError={pairingError}
          onPairingUriChange={setPairingUri}
          onPair={() => void pair()}
          onCancelPairing={() => void cancelPairing()}
          onReconnect={() => void reconnect()}
          executors={executors}
          selectedExecutorId={selectedExecutorId}
          onSelectExecutor={setSelectedExecutorId}
          sessionTitle={sessionTitle}
          onSessionTitleChange={setSessionTitle}
          projectLabel={projectLabel}
          onProjectLabelChange={setProjectLabel}
          model={model}
          onModelChange={setModel}
          firstPrompt={firstPrompt}
          onFirstPromptChange={setFirstPrompt}
          creating={creating}
          createError={createError}
          onCreateSession={() => void createSession()}
          sessions={sessions}
          onOpenSession={(sessionId) => void openSession(sessionId)}
        />
      ) : (
        <>
          <TranscriptHeader
            title={navigation.sessionId}
            view={turnView}
            onBack={() => setNavigation({ screen: 'sessions' })}
          />
          <TranscriptBlocks blocks={turnView?.blocks ?? []} />
          <TranscriptComposer
            prompt={nextPrompt}
            onPromptChange={setNextPrompt}
            onSubmit={() => void submitNextTurn()}
            onCancel={() => void cancelCurrentTurn()}
            submitting={submitting}
            submitError={submitError}
            view={turnView}
          />
        </>
      )}
      <ApprovalSheet
        snapshot={approvalSnapshot}
        onAllow={() => void resolveApproval(true)}
        onDeny={() => void resolveApproval(false)}
      />
    </SafeAreaView>
  )
}

interface SessionsScreenProps {
  readonly syncSnapshot: SessionControllerSnapshot
  readonly pairingUri: string
  readonly pairingError: string | null
  readonly onPairingUriChange: (value: string) => void
  readonly onPair: () => void
  readonly onCancelPairing: () => void
  readonly onReconnect: () => void
  readonly executors: readonly CodeExecutorRecord[]
  readonly selectedExecutorId: string | null
  readonly onSelectExecutor: (executorId: string) => void
  readonly sessionTitle: string
  readonly onSessionTitleChange: (value: string) => void
  readonly projectLabel: string
  readonly onProjectLabelChange: (value: string) => void
  readonly model: string
  readonly onModelChange: (value: string) => void
  readonly firstPrompt: string
  readonly onFirstPromptChange: (value: string) => void
  readonly creating: boolean
  readonly createError: string | null
  readonly onCreateSession: () => void
  readonly sessions: readonly CodeSessionSummary[]
  readonly onOpenSession: (sessionId: string) => void
}

function SessionsScreen(props: SessionsScreenProps) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>QVAC CODE</Text>
      <Text style={styles.title}>Dispatch from your phone.</Text>
      <ConnectionPanel
        snapshot={props.syncSnapshot}
        pairingUri={props.pairingUri}
        pairingError={props.pairingError}
        onPairingUriChange={props.onPairingUriChange}
        onPair={props.onPair}
        onCancel={props.onCancelPairing}
        onReconnect={props.onReconnect}
      />
      {props.syncSnapshot.state === 'ready' ? (
        <View style={styles.sections}>
          <ExecutorList
            executors={props.executors}
            selectedExecutorId={props.selectedExecutorId}
            onSelectExecutor={props.onSelectExecutor}
          />
          <SessionComposer
            state={props.syncSnapshot.state}
            title={props.sessionTitle}
            projectLabel={props.projectLabel}
            model={props.model}
            prompt={props.firstPrompt}
            executorId={props.selectedExecutorId}
            error={props.createError}
            creating={props.creating}
            onTitleChange={props.onSessionTitleChange}
            onProjectLabelChange={props.onProjectLabelChange}
            onModelChange={props.onModelChange}
            onPromptChange={props.onFirstPromptChange}
            onCreate={props.onCreateSession}
          />
          <SessionListFeed sessions={props.sessions} onOpenSession={props.onOpenSession} />
        </View>
      ) : null}
    </ScrollView>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// For the few rejections that have no place on screen -- lifecycle calls whose
// component is already gone, or whose failure the controller snapshot already
// carries. Never used to quiet a rejection the user should have seen.
function logFailure(what: string) {
  return (error: unknown) => {
    console.error(`[qvac-code-mobile] ${what} failed`, error)
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { gap: 24, padding: 20, paddingBottom: 56 },
  sections: { gap: 24 },
  eyebrow: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: fontWeight.bold,
    letterSpacing: 2
  },
  title: {
    color: colors.fg,
    fontSize: 28,
    fontWeight: fontWeight.bold
  }
})
