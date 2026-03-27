import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';

export default function TabsLayout() {
  const { colors } = useTheme();
  const { isTablet, maxContentWidth } = useResponsive();

  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: colors.bg },
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          elevation: 0,
          paddingTop: 4,
          height: 64,
          // Center the tab items on wide screens
          ...(isTablet && {
            maxWidth: maxContentWidth,
            alignSelf: 'center' as const,
            width: '100%',
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderLeftColor: colors.border,
            borderRightColor: colors.border,
          }),
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: {
          fontFamily: fonts.mono,
          fontSize: isTablet ? 11 : 10,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        },
        tabBarIconStyle: isTablet ? { marginBottom: 2 } : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
