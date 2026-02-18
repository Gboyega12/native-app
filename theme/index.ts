// ── Design System ──
// AMOLED black, blue accent, square edges, generous whitespace.
// WCAG AA compliant: all text ≥ 4.5:1 contrast on #000000.

export const colors = {
  // Surfaces
  bg: '#000000',
  surface: '#0A0A0A',
  border: 'rgba(255,255,255,0.10)',

  // Accent — confident blue
  accent: '#5B9CF5',
  accentDim: 'rgba(91,156,245,0.12)',

  // Semantic — warm red for destructive/warnings only
  coral: '#E05252',
  coralDim: 'rgba(224,82,82,0.10)',

  // Functional
  mint: '#FFFFFF',
  mintDim: 'rgba(255,255,255,0.06)',
  sky: '#5B9CF5',
  skyDim: 'rgba(91,156,245,0.10)',
  lavender: '#666666',

  // Text hierarchy — all pass WCAG AA on #000
  text: '#FFFFFF',       // 21:1
  text2: '#B0B0B0',      // 9.6:1
  dim: '#8A8A8A',        // 5.9:1
  muted: '#444444',      // 3.3:1 (decorative only)

  // Card
  card: '#060606',
};

export const fonts = {
  heading: 'Poppins_700Bold',
  semibold: 'Poppins_600SemiBold',
  medium: 'Poppins_500Medium',
  regular: 'Poppins_400Regular',
  mono: 'SpaceMono',
};

export const spacing = {
  xs: 6,
  sm: 12,
  md: 20,
  lg: 32,
  xl: 44,
  xxl: 64,
};

export const radius = {
  sm: 0,
  md: 0,
  lg: 0,
  xl: 0,
};
