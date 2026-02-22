// ── ResponsiveContainer ──
// Centers and constrains content width on tablet/desktop.
// On mobile, renders children with no extra wrapper.

import { View, StyleSheet } from 'react-native';
import { useResponsive } from '@/lib/responsive';

type Props = {
  children: React.ReactNode;
  /** Override the max width (defaults to responsive maxContentWidth) */
  maxWidth?: number;
  /** Additional style applied to the outer centering wrapper */
  style?: any;
};

export default function ResponsiveContainer({ children, maxWidth, style }: Props) {
  const { maxContentWidth, isTablet } = useResponsive();

  if (!isTablet) {
    return <>{children}</>;
  }

  return (
    <View style={[styles.wrapper, style]}>
      <View style={[styles.inner, { maxWidth: maxWidth ?? maxContentWidth }]}>
        {children}
      </View>
    </View>
  );
}

/**
 * Two-column grid wrapper for cards on tablet/desktop.
 * On mobile, renders children in a single column.
 */
export function ResponsiveGrid({ children, style }: { children: React.ReactNode; style?: any }) {
  const { gridColumns } = useResponsive();

  if (gridColumns <= 1) {
    return <>{children}</>;
  }

  return (
    <View style={[styles.grid, { gap: 16 }, style]}>
      {children}
    </View>
  );
}

/**
 * Wraps a single grid item to size correctly within ResponsiveGrid.
 * On mobile (gridColumns=1), renders with no extra wrapper.
 */
export function GridItem({ children, style }: { children: React.ReactNode; style?: any }) {
  const { gridColumns } = useResponsive();

  if (gridColumns <= 1) {
    return <>{children}</>;
  }

  // flex-basis for 2 columns with 16px gap
  return (
    <View style={[{ flexBasis: '48%', flexGrow: 1 }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    alignItems: 'center',
  },
  inner: {
    width: '100%',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
});
