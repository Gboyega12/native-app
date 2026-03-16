import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { apiSuccess, apiError, methodNotAllowed } from '../../lib/api-response.js';

const bodySchema = z.object({
  current_situation: z.string(),
  one_year_goal: z.string(),
  two_year_goal: z.string(),
  target_amount: z.number().optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (methodNotAllowed(res, req.method, 'POST')) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return apiError(res, 500, 'Server misconfigured');
  }

  // Verify JWT
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    return apiError(res, 401, 'Missing authorization token');
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return apiError(res, 401, 'Invalid token');
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiError(res, 400, 'Invalid request', parsed.error.flatten().fieldErrors);
  }
  const { current_situation, one_year_goal, two_year_goal, target_amount } = parsed.data;

  const admin = createClient(supabaseUrl, serviceKey);

  const { error } = await admin.from('goals').upsert({
    user_id: user.id,
    current_situation,
    one_year_goal,
    two_year_goal,
    target_amount: target_amount || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) {
    return apiError(res, 400, error.message);
  }

  return apiSuccess(res);
}
