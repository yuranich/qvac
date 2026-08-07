import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, lineHeight, radii, spacing } from './theme.ts'

export const approvalSheetStyles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'flex-end'
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    // Bounded so Allow/Deny can never be pushed off-screen by long
    // executor-controlled content (summary/detail) -- see scrollArea below.
    // Unbounded here previously let a long enough request scroll the action
    // row out of reach while still rendering it as tappable.
    maxHeight: '80%',
    padding: spacing.four,
    width: '100%'
  },
  scrollArea: {
    flexGrow: 0,
    flexShrink: 1
  },
  scrollContent: {
    gap: spacing.three,
    paddingBottom: spacing.three
  },
  footer: {
    gap: spacing.three,
    paddingTop: spacing.three
  },
  summary: {
    color: colors.fg,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.sm
  },
  toolRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.two },
  toolName: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase'
  },
  detailBox: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.three
  },
  detailLine: {
    color: colors.fgMuted,
    fontFamily: 'Courier',
    fontSize: fontSize.xs,
    lineHeight: lineHeight.xs
  },
  statusLine: {
    color: colors.fgMuted,
    fontSize: fontSize.xs
  },
  errorLine: {
    color: colors.error,
    fontSize: fontSize.xs
  },
  actionsRow: { flexDirection: 'row', gap: spacing.two },
  denyButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.sm,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44
  },
  denyButtonText: { color: colors.fg, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  allowButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44
  },
  allowButtonText: { color: colors.onAccent, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  disabledControl: { opacity: 0.45 }
})
