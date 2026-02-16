import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

export default function Profile() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [securityOpen, setSecurityOpen] = useState(false);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setName(user.user_metadata?.full_name || '');
      setEmail(user.email || '');
    }
  };

  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)/sign-in');
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete account',
      'This will permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const { data: { session } } = await supabase.auth.getSession();
              if (!session) return;

              const res = await fetch('/api/delete-account', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${session.access_token}`,
                },
              });

              const data = await res.json();
              if (data.success) {
                await supabase.auth.signOut();
                router.replace('/(auth)/sign-in');
              } else {
                Alert.alert('Error', 'Could not delete account. Please try again.');
              }
            } catch {
              Alert.alert('Error', 'Something went wrong. Please try again.');
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scroll}>
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || '?'}</Text>
        </View>
        <Text style={styles.name}>{name || 'User'}</Text>
        <Text style={styles.email}>{email}</Text>
      </View>

      {/* Menu Items */}
      <MenuItem
        icon="+"
        label="Add Account"
        onPress={() => router.push('/(main)/connect')}
      />
      <MenuItem
        icon=">"
        label="Goals"
        onPress={() => router.push('/(main)/goals')}
      />
      <MenuItem
        icon="@"
        label="Report a Bug"
        onPress={() => Linking.openURL('mailto:support@bocy.app?subject=Bug%20Report')}
      />
      <MenuItem
        icon="!"
        label="Notifications"
        onPress={() => Alert.alert('Coming soon', 'Notifications will be available in a future update.')}
        dimmed
      />
      <MenuItem
        icon="#"
        label="Agreements"
        onPress={() => Alert.alert('Coming soon', 'Agreements will be available in a future update.')}
        dimmed
      />

      {/* Security Section */}
      <TouchableOpacity
        style={styles.securityHeader}
        onPress={() => setSecurityOpen(!securityOpen)}
      >
        <Text style={styles.securityTitle}>Security</Text>
        <Text style={styles.securityChevron}>{securityOpen ? 'v' : '>'}</Text>
      </TouchableOpacity>

      {securityOpen && (
        <View style={styles.securityContent}>
          <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteAccount}>
            <Text style={styles.deleteText}>Delete account</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

function MenuItem({
  icon, label, onPress, dimmed,
}: {
  icon: string; label: string; onPress: () => void; dimmed?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress}>
      <Text style={[styles.menuIcon, dimmed && styles.dimmed]}>{icon}</Text>
      <Text style={[styles.menuLabel, dimmed && styles.dimmed]}>{label}</Text>
      <Text style={styles.menuChevron}>{'>'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.xl,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.xxl,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  avatarText: {
    fontFamily: fonts.semibold,
    fontSize: 24,
    color: colors.bg,
    fontWeight: '700',
  },
  name: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  email: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  menuIcon: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.accent,
    width: 28,
  },
  menuLabel: {
    fontFamily: fonts.regular,
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  menuChevron: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.muted,
  },
  dimmed: {
    color: colors.muted,
  },
  securityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  securityTitle: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: 'uppercase',
  },
  securityChevron: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.muted,
  },
  securityContent: {
    gap: spacing.sm,
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  signOutText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: colors.coralDim,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  deleteText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.coral,
  },
});
