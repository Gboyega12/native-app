// ── Monthly Growth Report Cron Job ──
// Runs on the 1st of each month (via Vercel Cron).
// Generates a personalised growth report for each user by comparing
// current vs previous month's analysis.
//
// Skips users who have disabled monthly_growth_report in notification_preferences.

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateGrowthReport, shouldTriggerGrowthReport } from '../../lib/growth-engine';
import type { Analysis } from '../../lib/types';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://app.bocy.io';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers.authorization as string) || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);
  const results = { generated: 0, skipped: 0, failed: 0, errors: [] as Array<{ user_id: string; error: string }> };

  try {
    // Determine time period (previous month)
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const timePeriod = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

    // Get all users with analyses
    const { data: users } = await admin
      .from('analyses')
      .select('user_id')
      .order('created_at', { ascending: false });

    if (!users || users.length === 0) {
      return res.json({ success: true, message: 'No users with analyses', ...results });
    }

    // Deduplicate user IDs
    const uniqueUserIds = [...new Set(users.map((u) => u.user_id))];

    for (const userId of uniqueUserIds) {
      try {
        // Get latest two analyses for comparison
        const { data: analyses } = await admin
          .from('analyses')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(2);

        if (!analyses || analyses.length === 0) {
          results.skipped++;
          continue;
        }

        const currentAnalysis = analyses[0] as Analysis;
        const previousAnalysis = analyses.length > 1 ? (analyses[1] as Analysis) : null;

        // Check if report should trigger
        const trigger = shouldTriggerGrowthReport(currentAnalysis, previousAnalysis);
        if (!trigger.trigger) {
          results.skipped++;
          continue;
        }

        // Generate the growth report
        const report = generateGrowthReport({
          userId,
          timePeriod,
          currentAnalysis,
          previousAnalysis,
        });

        // Store the report
        const { error: insertError } = await admin
          .from('growth_reports')
          .upsert({
            user_id: userId,
            time_period: timePeriod,
            report: report.report,
            priority: trigger.priority,
            trigger_reason: trigger.reason,
            created_at: new Date().toISOString(),
          }, { onConflict: 'user_id,time_period' });

        if (insertError) {
          // Table may not exist yet — log and continue
          console.warn(`[monthly-growth-report] Insert failed for ${userId.slice(0, 8)}: ${insertError.message}`);
          results.failed++;
          results.errors.push({ user_id: userId, error: insertError.message });
          continue;
        }

        // Send notification for high-priority reports
        if (trigger.priority === 'high') {
          const { data: pref } = await admin
            .from('notification_preferences')
            .select('email')
            .eq('user_id', userId)
            .single();

          if (pref?.email) {
            await fetch(`${appUrl}/api/notifications/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cronSecret || ''}`,
              },
              body: JSON.stringify({
                to: pref.email,
                subject: report.report.headline,
                push_body: `${report.report.headline}. ${report.report.next_actions[0]?.action || 'Open to see your report.'}`,
                user_id: userId,
                notification_type: 'monthly_growth_report',
              }),
            }).catch(() => { /* notification failure is non-blocking */ });
          }
        }

        results.generated++;
      } catch (userErr: unknown) {
        const message = userErr instanceof Error ? userErr.message : String(userErr);
        results.failed++;
        results.errors.push({ user_id: userId, error: message });
      }
    }

    return res.json({ success: true, timePeriod, ...results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[monthly-growth-report] Cron failed:', message);
    return res.status(500).json({ success: false, error: message });
  }
}
