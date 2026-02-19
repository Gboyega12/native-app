import { Stack } from 'expo-router';
import ErrorBoundary from '@/components/ErrorBoundary';

export default function MainLayout() {
  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#050505' } }} />
    </ErrorBoundary>
  );
}
