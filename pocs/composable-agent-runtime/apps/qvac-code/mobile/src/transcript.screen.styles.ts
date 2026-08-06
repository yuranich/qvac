import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, lineHeight, radii, spacing } from './theme.ts'

export const transcriptStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.three,
    padding: spacing.four
  },
  backButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold
  },
  headerCopy: { flex: 1 },
  headerTitle: {
    color: colors.fg,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold
  },
  headerStatus: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.half,
    textTransform: 'uppercase'
  },
  content: { gap: spacing.three, padding: spacing.four, paddingBottom: spacing.eight },
  block: { borderRadius: radii.md, padding: spacing.three },
  assistantBlock: { backgroundColor: colors.surface },
  assistantText: {
    color: colors.fg,
    fontSize: fontSize.sm,
    lineHeight: lineHeight.sm
  },
  thinkingBlock: { backgroundColor: colors.surfaceElevated },
  thinkingText: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    fontStyle: 'italic',
    lineHeight: lineHeight.xs
  },
  toolBlock: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1
  },
  toolHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.two
  },
  toolName: {
    color: colors.fg,
    fontFamily: 'Courier',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold
  },
  toolRequest: {
    color: colors.fgMuted,
    fontFamily: 'Courier',
    fontSize: fontSize.xs,
    marginTop: spacing.two
  },
  toolOutcome: {
    fontFamily: 'Courier',
    fontSize: fontSize.xs,
    marginTop: spacing.two
  },
  toolOutcomeOk: { color: colors.success },
  toolOutcomeFail: { color: colors.error },
  errorBlock: {
    backgroundColor: colors.surfaceError,
    borderColor: colors.error,
    borderWidth: 1
  },
  errorText: { color: colors.fg, fontSize: fontSize.sm },
  noticeBlock: { backgroundColor: 'transparent' },
  noticeText: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    fontStyle: 'italic'
  },
  emptyText: {
    color: colors.fgMuted,
    fontSize: fontSize.sm,
    padding: spacing.four,
    textAlign: 'center'
  },
  composer: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: spacing.two,
    padding: spacing.four
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.borderDisabled,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: colors.fg,
    fontSize: fontSize.sm,
    minHeight: 44,
    paddingHorizontal: spacing.three,
    paddingVertical: spacing.two
  },
  formError: { color: colors.error, fontSize: fontSize.xs },
  actionsRow: { flexDirection: 'row', gap: spacing.two },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44
  },
  primaryButtonText: {
    color: colors.onPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase'
  },
  cancelButton: {
    alignItems: 'center',
    borderColor: colors.error,
    borderRadius: radii.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.four
  },
  cancelButtonText: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold
  },
  disabledControl: { opacity: 0.4 }
})
