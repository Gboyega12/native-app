// ── Supabase Data Provider ──
// Concrete implementation of the DataProvider interface for the agent pipeline.
// Wraps Supabase service-role queries so agents can fetch user data.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import EnrichmentEngine from './enrichment-engine';
import type { DataProvider } from './agent-runner';
import type {
  EnrichedTransaction,
  FinancialProfile,
  DebtAccount,
  UserIdentity,
  Goals,
  ValidationResult,
} from './types';

export class SupabaseDataProvider implements DataProvider {
  private admin: SupabaseClient;

  constructor(admin: SupabaseClient) {
    this.admin = admin;
  }

  /** Create a provider using environment variables */
  static fromEnv(): SupabaseDataProvider {
    const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return new SupabaseDataProvider(createClient(url, key));
  }

  async getEnrichedTransactions(userId: string): Promise<{
    transactions: EnrichedTransaction[];
    profile: FinancialProfile;
    validation: ValidationResult;
  }> {
    // 1. Fetch CSV data
    const { data: bankRows } = await this.admin
      .from('bank_data')
      .select('csv_data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!bankRows || bankRows.length === 0) {
      throw new Error('No bank data found for user');
    }

    const rawLines: string[] = [];
    const perRowLines: string[][] = [];
    for (const row of bankRows) {
      if (!row.csv_data) continue;
      const lines = (row.csv_data as string).split('\n').slice(1).filter((l: string) => l.trim());
      perRowLines.push(lines);
      rawLines.push(...lines);
    }

    // Count-based dedup (same as enrich.ts)
    const uniqueLines = this.deduplicateCSVLines(rawLines, perRowLines);
    if (uniqueLines.length === 0) throw new Error('No transactions after deduplication');
    const csvData = ['Date,Description,Amount', ...uniqueLines].join('\n');

    // 2. Fetch overrides + debt accounts + identity
    const [overrideRes, debtRes, idRes] = await Promise.all([
      this.admin.from('transaction_overrides')
        .select('match_description, category, is_essential, direction')
        .eq('user_id', userId),
      this.admin.from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, is_default_apr, provider_name')
        .eq('user_id', userId),
      this.admin.from('user_identity')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    // 3. Fetch user name for self-transfer detection
    let selfName: string | undefined;
    try {
      const { data: { user } } = await this.admin.auth.admin.getUserById(userId);
      selfName = user?.user_metadata?.full_name;
    } catch { /* non-critical */ }

    // 4. Enrich
    const result = EnrichmentEngine.enrich(
      csvData,
      overrideRes.data || [],
      debtRes.data || [],
      idRes.data || null,
      selfName,
    );

    // 5. Run validation
    const validation = EnrichmentEngine.validateEnrichment(result.enrichedTransactions);

    return {
      transactions: result.enrichedTransactions,
      profile: result.profile,
      validation,
    };
  }

  async getAccountBalances(userId: string): Promise<
    Array<{ account_id: string; account_type: string; display_name?: string; provider?: string; balance?: number }>
  > {
    const { data, error } = await this.admin
      .from('account_balances')
      .select('account_id, account_type, display_name, provider, balance')
      .eq('user_id', userId);

    if (error) throw new Error(`Failed to fetch account balances: ${error.message}`);
    return data || [];
  }

  async getDebtAccounts(userId: string): Promise<DebtAccount[]> {
    const { data, error } = await this.admin
      .from('debt_accounts')
      .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, is_default_apr, provider_name, institution, connection_id, account_id')
      .eq('user_id', userId);

    if (error) throw new Error(`Failed to fetch debt accounts: ${error.message}`);
    return data || [];
  }

  async getUserConstraints(userId: string): Promise<{
    identity: UserIdentity | null;
    goals: Goals | null;
  }> {
    const [idRes, goalsRes] = await Promise.all([
      this.admin.from('user_identity')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
      this.admin.from('goals')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    return {
      identity: idRes.data || null,
      goals: goalsRes.data || null,
    };
  }

  // ── Deduplication (same logic as enrich.ts) ──

  private deduplicateCSVLines(csvLines: string[], perRowLines: string[][]): string[] {
    const normalise = (l: string) => l.trim().toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');

    if (perRowLines.length > 0) {
      const rowMaps = perRowLines.map((lines) => {
        const counts = new Map<string, number>();
        const ref = new Map<string, string>();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const key = normalise(trimmed);
          counts.set(key, (counts.get(key) || 0) + 1);
          if (!ref.has(key)) ref.set(key, trimmed);
        }
        return { counts, ref };
      });

      const allKeys = new Set<string>();
      for (const { counts } of rowMaps) {
        for (const k of counts.keys()) allKeys.add(k);
      }

      const unique: string[] = [];
      for (const k of allKeys) {
        let best = 0;
        let line = '';
        for (const { counts, ref } of rowMaps) {
          const c = counts.get(k) || 0;
          if (c > best) { best = c; line = ref.get(k) || line; }
        }
        for (let i = 0; i < best; i++) unique.push(line);
      }
      return unique;
    }

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of csvLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const key = normalise(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(trimmed);
    }
    return unique;
  }
}
