import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Unified plans endpoint: POST /api/plans with { action: "approve" | "dismiss", plan_id, user_id }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, plan_id, budget_item_id, user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id required' });
  }
  if (action !== 'approve' && action !== 'dismiss' && action !== 'delete' && action !== 'delete_budget_item') {
    return res.status(400).json({ error: 'action must be "approve", "dismiss", "delete", or "delete_budget_item"' });
  }
  if ((action === 'approve' || action === 'dismiss' || action === 'delete') && !plan_id) {
    return res.status(400).json({ error: 'plan_id required' });
  }
  if (action === 'delete_budget_item' && !budget_item_id) {
    return res.status(400).json({ error: 'budget_item_id required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  if (action === 'approve') {
    const { data, error } = await admin
      .from('user_plans')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', plan_id)
      .eq('user_id', user_id)
      .neq('status', 'dismissed')
      .select('id')
      .single();

    if (error) {
      console.error('[plans/approve] Update failed:', error.message, error.code);
      return res.status(400).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Plan not found or already dismissed' });
    }
    return res.json({ success: true, plan_id: data.id });
  }

  // delete — hard delete from user_plans
  if (action === 'delete') {
    const { error } = await admin
      .from('user_plans')
      .delete()
      .eq('id', plan_id)
      .eq('user_id', user_id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ success: true });
  }

  // delete_budget_item — hard delete from budget_adjustments
  if (action === 'delete_budget_item') {
    const { error } = await admin
      .from('budget_adjustments')
      .delete()
      .eq('id', budget_item_id)
      .eq('user_id', user_id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ success: true });
  }

  // dismiss
  const { error } = await admin
    .from('user_plans')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', plan_id)
    .eq('user_id', user_id)
    .neq('status', 'dismissed');

  if (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.json({ success: true });
}
