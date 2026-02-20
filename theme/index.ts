// ── Nothing Phone OS-inspired design system ──
// Monochrome philosophy with dark/light mode support.
// Primary accent: white (dark) / black (light). Secondary accent: teal mint.
// Typography: SpaceMono for dot-matrix feel, Poppins for body.

export type ThemeColors = typeof darkColors;

export const darkColors = {
  // Surfaces — true black for AMOLED, subtle grays for separation
  bg: '#000000',
  surface: '#141414',
  border: 'rgba(255,255,255,0.10)',

  // Accent — White primary, teal mint secondary
  accent: '#FFFFFF',
  accentDim: 'rgba(255,255,255,0.12)',
  green: '#00d4aa',
  greenDim: 'rgba(0,212,170,0.12)',

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

export const lightColors: ThemeColors = {
  // Surfaces — clean whites with subtle gray separation
  bg: '#F5F5F5',
  surface: '#FFFFFF',
  border: 'rgba(0,0,0,0.08)',

  // Accent — Black primary, teal mint secondary
  accent: '#000000',
  accentDim: 'rgba(0,0,0,0.06)',
  green: '#00b894',
  greenDim: 'rgba(0,184,148,0.10)',

  // Semantic — red for debt / shortages / destructive actions
  coral: '#D63031',
  coralDim: 'rgba(214,48,49,0.08)',

  // Functional tones — monochrome-first, subtle when needed
  mint: '#000000',
  mintDim: 'rgba(0,0,0,0.04)',
  sky: '#636E72',
  skyDim: 'rgba(99,110,114,0.08)',
  lavender: '#A0A0A0',

  // Text hierarchy
  text: '#1A1A1A',
  text2: '#636E72',
  dim: '#888888',
  muted: '#C0C0C0',

  // Card surface
  card: '#FAFAFA',
};

// Default export for backward compatibility
export const colors = darkColors;

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
