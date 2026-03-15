import { View, ActivityIndicator } from 'react-native';

// index.tsx is the app entry point. It renders a loading screen while AuthGate
// (in _layout.tsx) determines the correct route based on auth + onboarding state.
// We intentionally do NOT redirect here — AuthGate handles all routing to avoid
// bypassing onboarding for new users.

export default function Index() {
  return (
    <View style={{ flex: 1, backgroundColor: '#050505', justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color="#66DFCA" size="large" />
    </View>
  );
}
