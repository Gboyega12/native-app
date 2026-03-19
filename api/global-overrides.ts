// ── Global Merchant Category Overrides ──
// When a user categorises a merchant, the override is voted into a global table.
// After enough votes (≥3), the consensus is used for other users during enrichment.

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { normaliseDescription } from '../lib/normalise.js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { merchant, category, is_essential } = req.body || {};
  if (!merchant || !category) {
    return res.status(400).json({ error: 'merchant and category are required' });
  }

  const normalizedKey = normaliseDescription(merchant);
  if (!normalizedKey || normalizedKey.length < 2) {
    return res.status(400).json({ error: 'merchant too short to normalize' });
  }

  try {
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // Upsert: increment vote if same merchant + category, else insert new row
    const { error } = await admin.rpc('upsert_global_merchant_category', {
      p_normalized_key: normalizedKey,
      p_category: category,
      p_is_essential: is_essential ?? false,
    });

    // If RPC doesn't exist yet, fall back to direct upsert
    if (error?.message?.includes('function') || error?.code === '42883') {
      // Direct upsert fallback — works until the RPC is created
      const { data: existing } = await admin
        .from('global_merchant_categories')
        .select('id, vote_count')
        .eq('normalized_key', normalizedKey)
        .eq('category', category)
        .maybeSingle();

      if (existing) {
        await admin
          .from('global_merchant_categories')
          .update({
            vote_count: existing.vote_count + 1,
            is_essential: is_essential ?? false,
            last_voted_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await admin.from('global_merchant_categories').insert({
          normalized_key: normalizedKey,
          category,
          is_essential: is_essential ?? false,
          vote_count: 1,
        });
      }
    } else if (error) {
      throw error;
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error('[global-overrides] Error:', err?.message);
    return res.status(500).json({ error: 'Failed to save override' });
  }
}
