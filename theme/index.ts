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

  // Semantic — amber for warnings / expiring states
  amber: '#E8C55A',
  amberDim: 'rgba(232,197,90,0.12)',

  // Functional tones — monochrome-first, subtle when needed
  mint: '#FFFFFF',
  mintDim: 'rgba(255,255,255,0.08)',    // 8 % — visible dividers (was 6 %)
  sky: '#A0A0A0',                        // 8.1:1 on black
  skyDim: 'rgba(160,160,160,0.10)',
  lavender: '#777777',                   // 4.7:1 on black (was #666666 / 3.7:1)

  // Text hierarchy — all WCAG AA on black (#000)
  text: '#FFFFFF',                       // 21:1
  text2: '#A7A7A7',                      // 8.8:1
  dim: '#8A8A8A',                        // 6.1:1  — clearer tertiary (was #848484 / 5.6:1)
  muted: '#757575',                      // 4.6:1  — readable quaternary (was #3D3D3D / 1.9:1)

  // Card surface
  card: '#0A0A0A',

  // Switch / toggle controls
  trackOff: '#404040',                   // Perceptible track (was #333333)
  thumbOff: '#707070',                   // Visible inactive thumb (was #666666)
};

export const lightColors: ThemeColors = {
  // ── Surfaces ──
  // Warm-neutral gray bg creates clear lift for white cards.
  // WCAG: card-to-bg contrast ≥ 1.2:1 for perceivable boundaries.
  bg: '#EFEFEF',
  surface: '#FFFFFF',
  border: 'rgba(0,0,0,0.12)',           // 12 % — visible outlines (was 8 %)

  // ── Accent ──
  accent: '#000000',
  accentDim: 'rgba(0,0,0,0.10)',        // 10 % — card borders, outlines (was 6 %)
  green: '#009B77',                      // Deeper teal — 4.7:1 on white (was #00b894)
  greenDim: 'rgba(0,155,119,0.08)',

  // ── Semantic — red ──
  coral: '#C0392B',                      // Richer red — 5.7:1 on white (was #D63031)
  coralDim: 'rgba(192,57,43,0.08)',

  // ── Semantic — amber ──
  amber: '#946B00',                      // Dark golden — 4.8:1 on white
  amberDim: 'rgba(148,107,0,0.08)',

  // ── Functional tones ──
  mint: '#1A1A1A',
  mintDim: 'rgba(0,0,0,0.06)',          // 6 % — visible dividers (was 4 %)
  sky: '#4A5568',                        // Slate — 7.4:1 on white (was #636E72)
  skyDim: 'rgba(74,85,104,0.08)',
  lavender: '#6B7280',                   // Cool gray — 5.5:1 on white (was #A0A0A0)

  // ── Text hierarchy — all WCAG AA on white (#FFF) ──
  text: '#111111',                       // 18.2:1 — primary (was #1A1A1A)
  text2: '#4A4A4A',                      // 8.6:1  — secondary (was #636E72)
  dim: '#636E72',                        // 5.2:1  — tertiary (was #888888)
  muted: '#767676',                      // 4.6:1  — quaternary (was #C0C0C0)

  // ── Card surface ──
  card: '#FFFFFF',                       // Pure white — clear lift from bg (was #FAFAFA)

  // ── Switch / toggle controls ──
  trackOff: '#D1D5DB',                   // Soft gray track
  thumbOff: '#9CA3AF',                   // Visible thumb
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

// ── Card elevation shadows ──
// Platform-aware shadows for card depth. Nothing OS style: subtle, diffused.
// Three tiers: sm (subtle), md (standard cards), lg (hero/modals).
export const cardShadow = {
  dark: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  light: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  // Elevated variant for hero cards and modals
  darkElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  lightElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
} as const;

// ── Animation tokens ──
export const animation = {
  press: { scale: 0.975, duration: 120 },
  entrance: { duration: 500, stagger: 60 },
  expand: { duration: 280 },
} as const;
