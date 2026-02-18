// ── Nothing Phone OS-inspired design system ──
// Pure AMOLED black, monochrome philosophy, electric green accent.
// Typography: SpaceMono for dot-matrix feel, Poppins for body.

export const colors = {
  // Surfaces — true black for AMOLED, subtle grays for separation
  bg: '#000000',
  surface: '#141414',
  border: 'rgba(255,255,255,0.10)',

  // Accent — Electric green (used sparingly, never as a fill)
  accent: '#00FF87',
  accentDim: 'rgba(0,255,135,0.12)',

  // Semantic — red for debt / shortages / destructive actions
  coral: '#E05252',
  coralDim: 'rgba(224,82,82,0.10)',

  // Functional tones — monochrome-first, subtle when needed
  mint: '#FFFFFF',
  mintDim: 'rgba(255,255,255,0.06)',
  sky: '#A0A0A0',
  skyDim: 'rgba(160,160,160,0.10)',
  lavender: '#666666',

  // Text hierarchy
  text: '#FFFFFF',
  text2: '#A7A7A7',
  dim: '#848484',
  muted: '#3D3D3D',

  // Card surface
  card: '#0A0A0A',
};

export const fonts = {
  heading: 'Poppins_700Bold',
  semibold: 'Poppins_600SemiBold',
  medium: 'Poppins_500Medium',
  regular: 'Poppins_400Regular',
  mono: 'SpaceMono',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
};
