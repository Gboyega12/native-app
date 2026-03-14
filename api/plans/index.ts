import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const bodySchema = z.object({
  action: z.enum(['approve', 'dismiss', 'delete', 'delete_budget_item']),
  plan_id: z.string().optional(),
  budget_item_id: z.string().optional(),
}).refine(
  (data) => {
    if (['approve', 'dismiss', 'delete'].includes(data.action) && !data.plan_id) return false;
    if (data.action === 'delete_budget_item' && !data.budget_item_id) return false;
    return true;
  },
  { message: 'plan_id required for approve/dismiss/delete; budget_item_id required for delete_budget_item' }
);

// Unified plans endpoint: POST /api/plans with { action: "approve" | "dismiss", plan_id }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Verify JWT
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
  }
  const { action, plan_id, budget_item_id } = parsed.data;

  const admin = createClient(supabaseUrl, serviceKey);

  if (action === 'approve') {
    const { data, error } = await admin
      .from('user_plans')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', plan_id)
      .eq('user_id', user.id)
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
      .eq('user_id', user.id);

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
      .eq('user_id', user.id);

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
    .eq('user_id', user.id)
    .neq('status', 'dismissed');

  if (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.json({ success: true });
}
