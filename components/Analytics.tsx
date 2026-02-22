import { Platform } from 'react-native';

// Web-only Analytics component
// This component only loads on web platform to avoid breaking native builds
export function Analytics() {
  if (Platform.OS !== 'web') {
    return null;
  }

  // Dynamically import Analytics only on web
  // This ensures the native builds don't try to bundle web-specific code
  try {
    const { Analytics: VercelAnalytics } = require('@vercel/analytics/react');
    return <VercelAnalytics />;
  } catch (error) {
    // If the package is not available or fails to load, don't crash
    console.warn('Vercel Analytics failed to load:', error);
    return null;
  }
}
