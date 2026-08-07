import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, lineHeight, radii, spacing } from './theme.ts'

export const sessionListStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { gap: spacing.five, padding: spacing.five, paddingBottom: spacing.eight },
  eyebrow: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 2,
    marginTop: spacing.two
  },
  title: {
    color: colors.fg,
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight['2xl']
  },
  description: {
    color: colors.fgMuted,
    fontSize: fontSize.sm,
    lineHeight: lineHeight.sm
  },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.four
  },
  panelHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.three
  },
  dot: { borderRadius: radii.full, height: 10, width: 10 },
  dotReady: { backgroundColor: colors.success },
  dotWaiting: { backgroundColor: colors.warning },
  dotOffline: { backgroundColor: colors.fgMuted },
  dotError: { backgroundColor: colors.error },
  panelCopy: { flex: 1 },
  panelLabel: {
    color: colors.fg,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold
  },
  panelDetail: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    lineHeight: lineHeight.xs,
    marginTop: spacing.half
  },
  inputLabel: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.6,
    marginBottom: spacing.two,
    marginTop: spacing.four,
    textTransform: 'uppercase'
  },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.borderDisabled,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: colors.fg,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.three,
    paddingVertical: spacing.three
  },
  uriInput: {
    fontFamily: 'Courier',
    fontSize: fontSize.xs,
    minHeight: 64,
    textAlignVertical: 'top'
  },
  formError: {
    color: colors.error,
    fontSize: fontSize.xs,
    lineHeight: lineHeight.xs,
    marginTop: spacing.two
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.two,
    marginTop: spacing.three
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.four
  },
  primaryButtonText: {
    color: colors.onPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase'
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.borderDisabled,
    borderRadius: radii.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.three
  },
  secondaryButtonText: {
    color: colors.fg,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold
  },
  disabledControl: { opacity: 0.4 },
  sectionTitle: {
    color: colors.fg,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold
  },
  executorRow: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.three,
    marginTop: spacing.two,
    padding: spacing.three
  },
  executorRowSelected: { borderColor: colors.primary },
  executorCopy: { flex: 1 },
  executorId: {
    color: colors.fg,
    fontFamily: 'Courier',
    fontSize: fontSize.xs
  },
  emptyText: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.two
  },
  sessionCard: {
    backgroundColor: colors.surface,
    borderLeftColor: colors.primary,
    borderLeftWidth: 3,
    borderRadius: radii.md,
    marginTop: spacing.two,
    padding: spacing.three
  },
  sessionTitle: {
    color: colors.fg,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold
  },
  sessionMeta: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.half
  }
})
