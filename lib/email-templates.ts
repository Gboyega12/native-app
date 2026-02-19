// ── Email Templates ──
// HTML email templates for Bocy notifications.
// Minimal, dark-themed, consistent with the app's Nothing OS aesthetic.

import type { Achievement } from './achievements';

const BRAND_COLOR = '#00d4aa';
const BG_COLOR = '#0A0A0A';
const SURFACE_COLOR = '#141414';
const TEXT_COLOR = '#FFFFFF';
const TEXT_DIM = '#999999';
const BORDER_COLOR = '#1F1F1F';

function baseLayout(content: string, preheader: string = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Bocy</title>
  <style>
    body { margin: 0; padding: 0; background: ${BG_COLOR}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: ${TEXT_COLOR}; }
    .container { max-width: 520px; margin: 0 auto; padding: 32px 24px; }
    .card { background: ${SURFACE_COLOR}; border: 1px solid ${BORDER_COLOR}; border-radius: 14px; padding: 24px; margin-bottom: 16px; }
    .metric { display: inline-block; text-align: center; padding: 0 16px; }
    .metric-value { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
    .metric-label { font-size: 11px; color: ${TEXT_DIM}; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .divider { border: none; border-top: 1px solid ${BORDER_COLOR}; margin: 20px 0; }
    .btn { display: inline-block; background: ${TEXT_COLOR}; color: ${BG_COLOR}; padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; }
    .btn-green { background: ${BRAND_COLOR}; color: ${BG_COLOR}; }
    .green { color: ${BRAND_COLOR}; }
    .dim { color: ${TEXT_DIM}; }
    .small { font-size: 12px; }
    .center { text-align: center; }
    .preheader { display: none !important; max-height: 0; overflow: hidden; }
    h2 { font-size: 18px; font-weight: 600; margin: 0 0 16px 0; letter-spacing: -0.3px; }
    p { font-size: 14px; line-height: 22px; margin: 0 0 12px 0; }
    .achievement-badge { display: inline-block; width: 36px; height: 36px; line-height: 36px; text-align: center; background: ${BRAND_COLOR}20; color: ${BRAND_COLOR}; border: 1px solid ${BRAND_COLOR}40; border-radius: 50%; font-weight: 700; font-size: 14px; margin-right: 12px; }
    .score-bar { height: 6px; background: ${BORDER_COLOR}; border-radius: 3px; margin: 8px 0; }
    .score-fill { height: 6px; border-radius: 3px; }
    .move-item { padding: 12px 0; border-bottom: 1px solid ${BORDER_COLOR}; }
    .move-item:last-child { border-bottom: none; }
    .footer { text-align: center; margin-top: 32px; padding-top: 24px; border-top: 1px solid ${BORDER_COLOR}; }
  </style>
</head>
<body>
  <span class="preheader">${preheader}</span>
  <div class="container">
    <div class="center" style="margin-bottom: 24px;">
      <span style="font-size: 24px; font-weight: 800; letter-spacing: -1px;">B</span>
      <span style="font-size: 14px; color: ${TEXT_DIM}; margin-left: 4px;">Bocy</span>
    </div>
    ${content}
    <div class="footer">
      <p class="dim small">
        You're receiving this because you have a Bocy account.<br>
        <a href="{{unsubscribe_url}}" style="color: ${TEXT_DIM};">Manage email preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Weekly Digest ──

export interface WeeklyDigestData {
  name: string;
  decisionScore: number;
  scoreChange: number;
  monthlyIncome: number;
  monthlySpending: number;
  surplus: number;
  surplusChange: number;
  topCategory: string;
  topCategoryAmount: number;
  movesCompleted: number;
  totalMoves: number;
  topMove: string | null;
  topMoveImpact: number;
  newAchievements: Achievement[];
  streakDays: number;
  appUrl: string;
}

export function weeklyDigestEmail(data: WeeklyDigestData): { subject: string; html: string } {
  const scoreColor = data.scoreChange > 0 ? BRAND_COLOR : data.scoreChange < 0 ? '#E05252' : TEXT_DIM;
  const scoreArrow = data.scoreChange > 0 ? '\u2191' : data.scoreChange < 0 ? '\u2193' : '\u2192';
  const surplusColor = data.surplusChange > 0 ? BRAND_COLOR : data.surplusChange < 0 ? '#E05252' : TEXT_DIM;

  const achievementHtml = data.newAchievements.length > 0
    ? `<div class="card">
        <h2>New achievements</h2>
        ${data.newAchievements.map((a) => `
          <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <span class="achievement-badge">${a.icon}</span>
            <div>
              <strong>${a.name}</strong><br>
              <span class="dim small">${a.description}</span>
            </div>
          </div>
        `).join('')}
      </div>`
    : '';

  const moveHtml = data.topMove
    ? `<div class="card">
        <h2>Your top move</h2>
        <p>${data.topMove}</p>
        <p class="green" style="font-weight: 600;">\u00a3${Math.round(data.topMoveImpact * 12).toLocaleString()}/year impact</p>
        <div class="center" style="margin-top: 16px;">
          <a href="${data.appUrl}" class="btn-green btn">Open in Bocy</a>
        </div>
      </div>`
    : '';

  const content = `
    <div class="card">
      <h2>Hi ${data.name || 'there'}, here's your week</h2>
      <div class="center" style="padding: 16px 0;">
        <div class="metric">
          <div class="metric-value">${data.decisionScore}</div>
          <div class="metric-label">Score <span style="color: ${scoreColor};">${scoreArrow}${Math.abs(data.scoreChange)}</span></div>
        </div>
        <div class="metric">
          <div class="metric-value">\u00a3${Math.round(data.surplus).toLocaleString()}</div>
          <div class="metric-label">Surplus <span style="color: ${surplusColor};">${data.surplusChange >= 0 ? '+' : ''}\u00a3${Math.round(data.surplusChange).toLocaleString()}</span></div>
        </div>
      </div>
      <div class="score-bar">
        <div class="score-fill" style="width: ${data.decisionScore}%; background: ${BRAND_COLOR};"></div>
      </div>
      <hr class="divider">
      <p>
        <strong>Top spending:</strong> ${data.topCategory} at \u00a3${Math.round(data.topCategoryAmount).toLocaleString()}/mo<br>
        <strong>Moves completed:</strong> ${data.movesCompleted} of ${data.totalMoves}
        ${data.streakDays > 0 ? `<br><strong>Active days:</strong> ${data.streakDays} day streak` : ''}
      </p>
    </div>
    ${achievementHtml}
    ${moveHtml}
  `;

  return {
    subject: `Your score: ${data.decisionScore} ${scoreArrow}${Math.abs(data.scoreChange)} — Bocy Weekly`,
    html: baseLayout(content, `Decision score: ${data.decisionScore}. ${data.surplus >= 0 ? `\u00a3${Math.round(data.surplus)} surplus.` : `\u00a3${Math.round(Math.abs(data.surplus))} deficit.`}`),
  };
}

// ── Achievement Unlocked ──

export function achievementEmail(name: string, achievement: Achievement, appUrl: string): { subject: string; html: string } {
  const content = `
    <div class="card center">
      <div class="achievement-badge" style="width: 56px; height: 56px; line-height: 56px; font-size: 24px; margin: 0 auto 16px auto; display: block;">
        ${achievement.icon}
      </div>
      <h2>Achievement unlocked</h2>
      <p style="font-size: 18px; font-weight: 600; color: ${BRAND_COLOR}; margin-bottom: 4px;">${achievement.name}</p>
      <p class="dim">${achievement.description}</p>
      <div style="margin-top: 20px;">
        <a href="${appUrl}" class="btn">View in Bocy</a>
      </div>
    </div>
  `;

  return {
    subject: `${achievement.name} unlocked — ${achievement.description}`,
    html: baseLayout(content, `You earned: ${achievement.name} — ${achievement.description}`),
  };
}

// ── Proactive Check-in ──

export function checkinEmail(name: string, message: string, appUrl: string): { subject: string; html: string } {
  const content = `
    <div class="card">
      <div style="display: flex; align-items: center; margin-bottom: 16px;">
        <span style="font-size: 20px; font-weight: 800; margin-right: 8px;">B</span>
        <span class="dim small">Bocy</span>
      </div>
      <p>Hi ${name || 'there'},</p>
      <p>${message}</p>
      <div class="center" style="margin-top: 20px;">
        <a href="${appUrl}" class="btn-green btn">Chat with Bocy</a>
      </div>
    </div>
  `;

  return {
    subject: 'Bocy has a suggestion for you',
    html: baseLayout(content, message.slice(0, 100)),
  };
}

// ── Score Change Alert ──

export function scoreChangeEmail(
  name: string,
  oldScore: number,
  newScore: number,
  verdict: string,
  appUrl: string,
): { subject: string; html: string } {
  const delta = newScore - oldScore;
  const improved = delta > 0;
  const color = improved ? BRAND_COLOR : '#E05252';
  const arrow = improved ? '\u2191' : '\u2193';

  const content = `
    <div class="card center">
      <h2>Your decision score ${improved ? 'improved' : 'changed'}</h2>
      <div style="font-size: 48px; font-weight: 800; letter-spacing: -2px; color: ${color};">
        ${oldScore} ${arrow} ${newScore}
      </div>
      <div class="score-bar" style="margin: 16px 0;">
        <div class="score-fill" style="width: ${newScore}%; background: ${color};"></div>
      </div>
      <p class="dim">${verdict}</p>
      <div style="margin-top: 20px;">
        <a href="${appUrl}" class="btn">See what changed</a>
      </div>
    </div>
  `;

  return {
    subject: `Score ${arrow} ${Math.abs(delta)} — now ${newScore} (${verdict})`,
    html: baseLayout(content, `Your decision score went from ${oldScore} to ${newScore}.`),
  };
}
