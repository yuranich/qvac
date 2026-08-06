import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import type { CodeTranscriptBlock, CodeTurnView } from '@qvac-poc/qvac-code-shared'
import { transcriptStyles as styles } from './transcript.screen.styles.ts'
import { colors } from './theme.ts'

const RUNNING_STATUSES = new Set(['queued', 'claimed', 'running', 'awaiting-approval'])

interface TranscriptHeaderProps {
  readonly title: string
  readonly view: CodeTurnView | null
  readonly onBack: () => void
}

export function TranscriptHeader(props: TranscriptHeaderProps) {
  return (
    <View style={styles.header}>
      <TouchableOpacity accessibilityRole="button" onPress={props.onBack}>
        <Text style={styles.backButtonText}>Back</Text>
      </TouchableOpacity>
      <View style={styles.headerCopy}>
        <Text style={styles.headerTitle}>{props.title}</Text>
        <Text style={styles.headerStatus}>{props.view?.status ?? 'loading'}</Text>
      </View>
    </View>
  )
}

export function TranscriptBlocks({ blocks }: { readonly blocks: readonly CodeTranscriptBlock[] }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {blocks.length === 0 ? (
        <Text style={styles.emptyText}>Waiting for the executor to pick up this turn...</Text>
      ) : (
        blocks.map((block, index) => <TranscriptBlockView key={index} block={block} />)
      )}
    </ScrollView>
  )
}

function TranscriptBlockView({ block }: { readonly block: CodeTranscriptBlock }) {
  if (block.kind === 'assistant') {
    return (
      <View style={[styles.block, styles.assistantBlock]}>
        <Text selectable style={styles.assistantText}>
          {block.text}
        </Text>
      </View>
    )
  }
  if (block.kind === 'thinking') {
    return (
      <View style={[styles.block, styles.thinkingBlock]}>
        <Text numberOfLines={3} style={styles.thinkingText}>
          {block.text}
        </Text>
      </View>
    )
  }
  if (block.kind === 'tool') {
    return (
      <View style={[styles.block, styles.toolBlock]}>
        <View style={styles.toolHeader}>
          <Text style={styles.toolName}>{block.name}</Text>
          {block.outcome === null ? <ActivityIndicator color={colors.primary} size="small" /> : null}
        </View>
        <Text style={styles.toolRequest}>{block.request}</Text>
        {block.outcome ? (
          <Text
            style={[
              styles.toolOutcome,
              block.outcome.ok ? styles.toolOutcomeOk : styles.toolOutcomeFail
            ]}
          >
            {block.outcome.summary}
          </Text>
        ) : null}
      </View>
    )
  }
  if (block.kind === 'approval') {
    return (
      <View style={[styles.block, styles.toolBlock]}>
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={styles.toolRequest}>{block.summary}</Text>
        <Text style={styles.toolOutcome}>
          {block.decision == null
            ? block.stale
              ? 'stale'
              : 'awaiting approval'
            : block.decision.verdict}
        </Text>
      </View>
    )
  }
  if (block.kind === 'error') {
    return (
      <View style={[styles.block, styles.errorBlock]}>
        <Text style={styles.errorText}>{block.message}</Text>
      </View>
    )
  }
  return (
    <View style={[styles.block, styles.noticeBlock]}>
      <Text style={styles.noticeText}>{block.text}</Text>
    </View>
  )
}

interface TranscriptComposerProps {
  readonly prompt: string
  readonly onPromptChange: (value: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
  readonly submitting: boolean
  readonly submitError: string | null
  readonly view: CodeTurnView | null
}

export function TranscriptComposer(props: TranscriptComposerProps) {
  const running = props.view != null && RUNNING_STATUSES.has(props.view.status)
  // With no claimed executor there is no target to send to, and the submit
  // handler returns without sending -- so the button must not look live.
  const disabled =
    props.submitting || props.prompt.trim().length === 0 || props.view?.claimedBy == null
  return (
    <View style={styles.composer}>
      <TextInput
        accessibilityLabel="Next turn prompt"
        editable={!props.submitting}
        multiline
        onChangeText={props.onPromptChange}
        placeholder="Send the next turn..."
        placeholderTextColor={colors.fgMuted}
        style={styles.input}
        value={props.prompt}
      />
      {props.submitError ? <Text style={styles.formError}>{props.submitError}</Text> : null}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={disabled}
          onPress={props.onSubmit}
          style={[styles.primaryButton, disabled ? styles.disabledControl : null]}
        >
          <Text style={styles.primaryButtonText}>
            {props.submitting ? 'Sending...' : 'Send'}
          </Text>
        </TouchableOpacity>
        {running ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={props.onCancel}
            style={styles.cancelButton}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  )
}
