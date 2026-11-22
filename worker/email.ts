/**
 * Non-blocking transactional "Thank you & Welcome" email helper via Resend REST API.
 * Runs cleanly inside Cloudflare Workers `ctx.waitUntil(...)` and local Node preview.
 * If RESEND_API_KEY or FROM_EMAIL are not yet configured (e.g., before custom domain DNS
 * verification), logs the attempt cleanly and allows registration to succeed without error.
 */

export interface WelcomeEmailEnv {
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendWelcomeEmail(
  env: WelcomeEmailEnv,
  toEmail: string,
  username: string,
): Promise<{ sent: boolean; skipped?: boolean; reason?: string }> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.FROM_EMAIL?.trim();

  if (!apiKey || !fromEmail) {
    console.info(
      `[WelcomeEmail] Skipped sending welcome email to ${toEmail} (${username}) — RESEND_API_KEY / FROM_EMAIL not configured yet.`,
    );
    return { sent: false, skipped: true, reason: 'email_secrets_not_configured' };
  }

  const safeUsername = escapeHtml(username);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `Welcome to AXON ENGINE, ${username}`,
        html: `
          <div style="background:#090a0b;color:#f5f5f5;padding:32px;font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;border:1px solid #262626;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#f59e0b;margin-bottom:8px;">AXON ENGINE // TACTICAL BODYCAM</div>
            <h1 style="margin:0 0 16px;font-size:24px;color:#ffffff;">Welcome aboard, ${safeUsername}.</h1>
            <p style="margin:0 0 14px;line-height:1.6;color:#d4d4d4;">
              Thank you for creating your AXON ENGINE account. Your callsign is reserved and your career rank, gun progression, friends list, and Special Events are now ready across sessions.
            </p>
            <p style="margin:0 0 20px;line-height:1.6;color:#a3a3a3;font-size:13px;">
              You start at Rank 1 (Private) with your starter loadout and Mosin-Nagant scope unlocked. Earn Rank XP and per-gun XP in matches to expand your armory and unlock global attachments.
            </p>
            <div style="border-top:1px solid #262626;padding-top:14px;font-size:12px;color:#737373;">
              See you in the sector — AXON ENGINE Operations
            </div>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[WelcomeEmail] Resend API returned ${res.status}: ${errText}`);
      return { sent: false, reason: `resend_http_${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.warn('[WelcomeEmail] Non-blocking email dispatch failed:', err);
    return { sent: false, reason: 'network_error' };
  }
}
