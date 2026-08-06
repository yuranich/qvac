import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import type { ApprovalSheetSnapshot } from './approval-controller.ts'
import { approvalSheetStyles as styles } from './approval-sheet.styles.ts'

interface ApprovalSheetProps {
  readonly snapshot: ApprovalSheetSnapshot
  readonly onAllow: () => void
  readonly onDeny: () => void
}

/**
 * A modal card in the PermissionPrompt spirit: what is being asked, the tool
 * name, the detail lines, and Deny/Allow. Every rendering decision here comes
 * straight from `status`, which approval-controller.ts derives only from
 * watch frames -- see that module's doc comment for why a local resolve must
 * never be allowed to paint this sheet as decided.
 */
export function ApprovalSheet(props: ApprovalSheetProps) {
  if (props.snapshot.kind === 'hidden') return null
  const { name, summary, detail, status, error } = props.snapshot
  const disabled = status.kind === 'sending' || status.kind === 'decided' || status.kind === 'stale'

  return (
    <Modal animationType="fade" transparent visible>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/*
            The request itself -- summary/tool/detail -- is executor-authored
            and unbounded in length. It scrolls inside its own region so a
            long request cannot push Allow/Deny out of reach while they stay
            tappable: the footer below is a sibling, not scrolled content.
          */}
          <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.summary}>{summary}</Text>
            <View style={styles.toolRow}>
              <Text style={styles.toolName}>{name}</Text>
            </View>
            {detail.length > 0 ? (
              <View style={styles.detailBox}>
                {detail.map((line, index) => (
                  <Text key={index} style={styles.detailLine}>
                    {line}
                  </Text>
                ))}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.footer}>
            <StatusLine status={status} error={error} />
            <View style={styles.actionsRow}>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={disabled}
                onPress={props.onDeny}
                style={[styles.denyButton, disabled ? styles.disabledControl : null]}
              >
                <Text style={styles.denyButtonText}>Deny</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={disabled}
                onPress={props.onAllow}
                style={[styles.allowButton, disabled ? styles.disabledControl : null]}
              >
                <Text style={styles.allowButtonText}>Allow</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function StatusLine({
  status,
  error
}: {
  readonly status: Extract<ApprovalSheetSnapshot, { kind: 'visible' }>['status']
  readonly error: string | null
}) {
  if (error) return <Text style={styles.errorLine}>{error}</Text>
  if (status.kind === 'sending') return <Text style={styles.statusLine}>Sending decision...</Text>
  if (status.kind === 'stale') {
    return <Text style={styles.statusLine}>This turn already finished.</Text>
  }
  if (status.kind === 'decided') {
    // withdrawn/unanswered must render as exactly that word: they mean
    // nobody decided, which is a different fact than "denied".
    return <Text style={styles.statusLine}>{status.verdict}</Text>
  }
  return null
}
