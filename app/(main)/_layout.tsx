import { Stack } from 'expo-router';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useTheme } from '@/lib/theme-context';

export default function MainLayout() {
  const { colors } = useTheme();

  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </ErrorBoundary>
  );
}
