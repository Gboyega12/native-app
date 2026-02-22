// ── Responsive layout utilities ──
// Provides breakpoints, screen tier detection, and layout helpers
// for desktop, iPad, and mobile responsiveness.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dimensions, ScaledSize } from 'react-native';

// ── Breakpoints (min-width) ──
export const breakpoints = {
  /** Small phones */
  sm: 0,
  /** Standard phones / small tablets in portrait */
  md: 768,
  /** iPad landscape / small desktops */
  lg: 1024,
  /** Large desktops */
  xl: 1440,
} as const;

export type ScreenTier = 'sm' | 'md' | 'lg' | 'xl';

function getTier(width: number): ScreenTier {
  if (width >= breakpoints.xl) return 'xl';
  if (width >= breakpoints.lg) return 'lg';
  if (width >= breakpoints.md) return 'md';
  return 'sm';
}

export type ResponsiveInfo = {
  /** Current screen width */
  width: number;
  /** Current screen height */
  height: number;
  /** sm | md | lg | xl */
  tier: ScreenTier;
  /** Tablet-sized or larger (>= 768) */
  isTablet: boolean;
  /** Desktop-sized or larger (>= 1024) */
  isDesktop: boolean;
  /** Max content width for centered layouts */
  maxContentWidth: number;
  /** Number of columns for card grids */
  gridColumns: number;
  /** Horizontal padding that scales with screen */
  horizontalPadding: number;
};

/**
 * Hook that provides responsive layout information.
 * Listens to window dimension changes and returns screen tier,
 * grid column count, max content width, etc.
 */
export function useResponsive(): ResponsiveInfo {
  const [dims, setDims] = useState(() => Dimensions.get('window'));

  useEffect(() => {
    const handler = ({ window }: { window: ScaledSize }) => {
      setDims(window);
    };
    const sub = Dimensions.addEventListener('change', handler);
    return () => sub.remove();
  }, []);

  return useMemo(() => {
    const { width, height } = dims;
    const tier = getTier(width);
    const isTablet = width >= breakpoints.md;
    const isDesktop = width >= breakpoints.lg;

    // Max content width: constrain on larger screens
    const maxContentWidth = isDesktop ? 960 : isTablet ? 720 : width;

    // Grid columns: 1 on phone, 2 on tablet, 2-3 on desktop
    const gridColumns = isDesktop ? 2 : isTablet ? 2 : 1;

    // Horizontal padding scales up on wider screens
    const horizontalPadding = isDesktop ? 48 : isTablet ? 36 : 24;

    return { width, height, tier, isTablet, isDesktop, maxContentWidth, gridColumns, horizontalPadding };
  }, [dims]);
}
