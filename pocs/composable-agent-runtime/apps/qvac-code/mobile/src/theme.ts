// Plain-constant port of the wb design tokens (see
// /Users/yury/dev/wb/ui/src/tokens.ts) for the dark palette only --
// app.json pins userInterfaceStyle to "dark", and this app does not ship a
// light variant. Reimplemented here rather than imported: this app must not
// depend on wb or its NativeWind stack, only match its look with plain
// StyleSheet, the same way task-mobile does.

export const colors = {
  bg: '#161718',
  surface: '#252728',
  surfaceElevated: '#1E1F20',
  surfaceSelected: '#095B4D',
  primary: '#16E3C1',
  secondary: '#095B4D',
  fg: '#FFFFFF',
  fgMuted: '#7C7D7E',
  onPrimary: '#0F1010',
  accent: '#FFFFFF',
  onAccent: '#0F1010',
  border: '#252728',
  borderStrong: '#FFFFFF',
  borderDisabled: '#515253',
  disabled: '#515253',
  error: '#F05454',
  warning: '#FDCA40',
  success: '#3CB371',
  surfaceSuccess: '#18482D',
  surfaceError: '#602222',
  surfaceWarning: '#65511A'
} as const

export const spacing = {
  px: 1,
  half: 2,
  one: 4,
  two: 8,
  three: 12,
  four: 16,
  five: 24,
  six: 32,
  seven: 48,
  eight: 64
} as const

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999
} as const

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  h6: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48
} as const

export const lineHeight = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 28,
  h6: 24,
  xl: 32,
  '2xl': 44,
  '3xl': 52
} as const

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700'
} as const
