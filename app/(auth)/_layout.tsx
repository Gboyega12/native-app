import { Stack } from 'expo-router';
import ErrorBoundary from '@/components/ErrorBoundary';

export default function AuthLayout() {
  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000000' } }} />
    </ErrorBoundary>
  );
}
