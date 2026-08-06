import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import type { CodeSessionSummary } from '@qvac-poc/qvac-code-shared'
import type { CodeExecutorRecord } from '@qvac-poc/qvac-code-shared/store'
import type {
  SessionControllerSnapshot,
  SessionControllerState
} from './session-controller.ts'
import { sessionListStyles as styles } from './session-list.screen.styles.ts'
import { colors } from './theme.ts'

interface ConnectionPanelProps {
  readonly snapshot: SessionControllerSnapshot
  readonly pairingUri: string
  readonly pairingError: string | null
  readonly onPairingUriChange: (value: string) => void
  readonly onPair: () => void
  readonly onCancel: () => void
  readonly onReconnect: () => void
}

export function ConnectionPanel(props: ConnectionPanelProps) {
  const copy = connectionCopy(props.snapshot)
  const waiting =
    props.snapshot.state === 'connecting' || props.snapshot.state === 'awaiting-approval'
  const paired = props.snapshot.state === 'ready'

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <View style={[styles.dot, connectionDotStyle(props.snapshot.state)]} />
        <View style={styles.panelCopy}>
          <Text style={styles.panelLabel}>{copy.label}</Text>
          <Text style={styles.panelDetail}>{copy.detail}</Text>
        </View>
        {waiting ? <ActivityIndicator color={colors.primary} /> : null}
      </View>

      {!paired ? (
        <>
          <Text style={styles.inputLabel}>Pairing URI</Text>
          <TextInput
            accessibilityLabel="Pairing URI"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={props.onPairingUriChange}
            placeholder="qvac-poc://pair?invite=..."
            placeholderTextColor={colors.fgMuted}
            style={[styles.input, styles.uriInput]}
            value={props.pairingUri}
          />
          {props.pairingError ? (
            <Text style={styles.formError}>{props.pairingError}</Text>
          ) : null}
          <View style={styles.actionsRow}>
            <PrimaryButton
              label="Request pairing"
              disabled={waiting || props.pairingUri.trim().length === 0}
              onPress={props.onPair}
            />
            {waiting ? (
              <SecondaryButton label="Cancel pairing" onPress={props.onCancel} />
            ) : null}
            {props.snapshot.state === 'offline' || props.snapshot.state === 'error' ? (
              <SecondaryButton label="Reconnect" onPress={props.onReconnect} />
            ) : null}
          </View>
        </>
      ) : (
        <Text style={styles.panelDetail}>
          {props.snapshot.deviceCount} device{props.snapshot.deviceCount === 1 ? '' : 's'} connected
        </Text>
      )}
    </View>
  )
}

interface ExecutorListProps {
  readonly executors: readonly CodeExecutorRecord[]
  readonly selectedExecutorId: string | null
  readonly onSelectExecutor: (executorId: string) => void
}

export function ExecutorList(props: ExecutorListProps) {
  return (
    <View>
      <Text style={styles.sectionTitle}>Executors</Text>
      {props.executors.length === 0 ? (
        <Text style={styles.emptyText}>No executor is currently advertising presence.</Text>
      ) : (
        props.executors.map((executor) => (
          <TouchableOpacity
            accessibilityRole="button"
            key={executor.executorId}
            onPress={() => props.onSelectExecutor(executor.executorId)}
            style={[
              styles.executorRow,
              executor.executorId === props.selectedExecutorId
                ? styles.executorRowSelected
                : null
            ]}
          >
            <View style={[styles.dot, styles.dotReady]} />
            <View style={styles.executorCopy}>
              <Text style={styles.executorId}>{executor.executorId}</Text>
            </View>
          </TouchableOpacity>
        ))
      )}
    </View>
  )
}

interface SessionComposerProps {
  readonly state: SessionControllerState
  readonly title: string
  readonly projectLabel: string
  readonly model: string
  readonly prompt: string
  readonly executorId: string | null
  readonly error: string | null
  readonly creating: boolean
  readonly onTitleChange: (value: string) => void
  readonly onProjectLabelChange: (value: string) => void
  readonly onModelChange: (value: string) => void
  readonly onPromptChange: (value: string) => void
  readonly onCreate: () => void
}

export function SessionComposer(props: SessionComposerProps) {
  const disabled =
    props.state !== 'ready' ||
    props.creating ||
    props.executorId == null ||
    props.title.trim().length === 0 ||
    props.prompt.trim().length === 0
  return (
    <View style={styles.panel}>
      <Text style={styles.sectionTitle}>New session</Text>
      <Text style={styles.inputLabel}>Title</Text>
      <TextInput
        accessibilityLabel="Session title"
        editable={props.state === 'ready' && !props.creating}
        onChangeText={props.onTitleChange}
        placeholder="Fix the flaky test"
        placeholderTextColor={colors.fgMuted}
        style={styles.input}
        value={props.title}
      />
      <Text style={styles.inputLabel}>Project label</Text>
      <TextInput
        accessibilityLabel="Project label"
        editable={props.state === 'ready' && !props.creating}
        onChangeText={props.onProjectLabelChange}
        placeholder="composable-agent-runtime"
        placeholderTextColor={colors.fgMuted}
        style={styles.input}
        value={props.projectLabel}
      />
      <Text style={styles.inputLabel}>Model</Text>
      <TextInput
        accessibilityLabel="Model"
        editable={props.state === 'ready' && !props.creating}
        onChangeText={props.onModelChange}
        placeholder="qwen3.5-4b"
        placeholderTextColor={colors.fgMuted}
        style={styles.input}
        value={props.model}
      />
      <Text style={styles.inputLabel}>Prompt</Text>
      <TextInput
        accessibilityLabel="Session prompt"
        editable={props.state === 'ready' && !props.creating}
        multiline
        onChangeText={props.onPromptChange}
        placeholder="Describe the first turn..."
        placeholderTextColor={colors.fgMuted}
        style={[styles.input, { minHeight: 88 }]}
        textAlignVertical="top"
        value={props.prompt}
      />
      {props.error ? <Text style={styles.formError}>{props.error}</Text> : null}
      <View style={styles.actionsRow}>
        <PrimaryButton
          label={props.creating ? 'Creating...' : 'Create session'}
          disabled={disabled}
          onPress={props.onCreate}
        />
      </View>
    </View>
  )
}

interface SessionListFeedProps {
  readonly sessions: readonly CodeSessionSummary[]
  readonly onOpenSession: (sessionId: string) => void
}

export function SessionListFeed(props: SessionListFeedProps) {
  return (
    <View>
      <Text style={styles.sectionTitle}>Sessions</Text>
      {props.sessions.length === 0 ? (
        <Text style={styles.emptyText}>No sessions yet.</Text>
      ) : (
        props.sessions.map((session) => (
          <TouchableOpacity
            accessibilityRole="button"
            key={session.sessionId}
            onPress={() => props.onOpenSession(session.sessionId)}
            style={styles.sessionCard}
          >
            <Text style={styles.sessionTitle}>{session.title}</Text>
            <Text style={styles.sessionMeta}>
              {session.projectLabel ? `${session.projectLabel} - ` : ''}
              {session.status}
            </Text>
          </TouchableOpacity>
        ))
      )}
    </View>
  )
}

function PrimaryButton({
  label,
  disabled = false,
  onPress
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onPress: () => void
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.primaryButton, disabled ? styles.disabledControl : null]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </TouchableOpacity>
  )
}

function SecondaryButton({
  label,
  onPress
}: {
  readonly label: string
  readonly onPress: () => void
}) {
  return (
    <TouchableOpacity accessibilityRole="button" onPress={onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </TouchableOpacity>
  )
}

function connectionDotStyle(state: SessionControllerState) {
  if (state === 'ready') return styles.dotReady
  if (state === 'error') return styles.dotError
  if (state === 'offline' || state === 'idle') return styles.dotOffline
  return styles.dotWaiting
}

interface ConnectionCopy {
  readonly label: string
  readonly detail: string
}

function connectionCopy(snapshot: SessionControllerSnapshot): ConnectionCopy {
  if (snapshot.state === 'idle') {
    return {
      label: 'Not paired',
      detail: 'Paste the pairing URI shown by the desktop service.'
    }
  }
  if (snapshot.state === 'connecting') {
    return { label: 'Connecting', detail: 'Opening the saved Sync session.' }
  }
  if (snapshot.state === 'awaiting-approval') {
    return {
      label: 'Awaiting desktop approval',
      detail: 'Confirm this device in the desktop terminal.'
    }
  }
  if (snapshot.state === 'ready') {
    return { label: 'Paired', detail: 'This phone can start sessions and dispatch turns.' }
  }
  if (snapshot.state === 'offline') {
    return { label: 'Offline', detail: 'Sync disconnected. Reconnect to the saved session.' }
  }
  return { label: 'Connection error', detail: snapshot.error ?? 'Sync could not connect.' }
}
