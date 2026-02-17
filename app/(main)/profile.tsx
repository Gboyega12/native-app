import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking,
  LayoutAnimation,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

export default function Profile() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [connectedBanks, setConnectedBanks] = useState<any[]>([]);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setName(user.user_metadata?.full_name || '');
      setEmail(user.email || '');
      // Fetch connected bank accounts
      const { data: banks } = await supabase
        .from('bank_data')
        .select('id, connection_id, source, created_at, updated_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });
      if (banks) setConnectedBanks(banks);
    }
  };

  const handleRemoveBank = (bankId: string, connectionId: string) => {
    Alert.alert(
      'Remove bank connection',
      'This will remove this bank connection and its transaction data. You can reconnect it later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('bank_data').delete().eq('id', bankId);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setConnectedBanks((prev) => prev.filter((b) => b.id !== bankId));
          },
        },
      ],
    );
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
              if (!session) {
                Alert.alert('Error', 'You are not signed in.');
                return;
              }

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
                Alert.alert('Error', data.error || 'Could not delete account. Please try again.');
              }
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Something went wrong. Please try again.');
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

      {/* Connected Banks */}
      <Text style={styles.sectionLabel}>CONNECTED BANKS</Text>
      {connectedBanks.length > 0 ? (
        connectedBanks.map((bank, i) => {
          const connDate = new Date(bank.created_at);
          const lastSync = bank.updated_at ? new Date(bank.updated_at) : null;
          return (
            <View key={bank.id} style={styles.bankRow}>
              <View style={styles.bankInfo}>
                <Text style={styles.bankName}>Bank account {i + 1}</Text>
                <Text style={styles.bankMeta}>
                  Connected {connDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {lastSync ? ` · Last synced ${lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.bankRemove}
                onPress={() => handleRemoveBank(bank.id, bank.connection_id)}
              >
                <Text style={styles.bankRemoveText}>Remove</Text>
              </TouchableOpacity>
            </View>
          );
        })
      ) : (
        <Text style={styles.noBanksText}>No banks connected yet</Text>
      )}
      <TouchableOpacity
        style={styles.addBankButton}
        onPress={() => router.push('/(main)/connect')}
      >
        <Text style={styles.addBankText}>+ Add {connectedBanks.length > 0 ? 'another' : 'a'} bank account</Text>
      </TouchableOpacity>

      {/* Menu Items */}
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
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  bankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  bankInfo: {
    flex: 1,
  },
  bankName: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  bankMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
  },
  bankRemove: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  bankRemoveText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.coral,
  },
  noBanksText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  addBankButton: {
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderStyle: 'dashed' as any,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  addBankText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
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
