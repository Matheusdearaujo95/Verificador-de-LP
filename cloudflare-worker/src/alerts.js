import { WorkerMailer } from 'worker-mailer';

export async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('[alerta] Telegram não configurado (faltam TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)');
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (err) {
    console.log(`[alerta] falha ao enviar Telegram: ${err.message}`);
  }
}

export async function sendEmail(env, subject, message) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.log('[alerta] e-mail não configurado (faltam variáveis SMTP_*)');
    return;
  }
  let mailer;
  try {
    mailer = await WorkerMailer.connect({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: false, // STARTTLS é negociado automaticamente na porta 587
      credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
      authType: 'plain',
    });
    const toAddrs = (env.ALERT_EMAIL_TO || env.SMTP_USER || '')
      .split(',')
      .map((addr) => addr.trim())
      .filter(Boolean);
    await mailer.send({
      from: { email: env.SMTP_USER },
      to: toAddrs,
      subject: `[Vigia] ${subject}`,
      text: message,
    });
  } catch (err) {
    console.log(`[alerta] falha ao enviar e-mail: ${err.message}`);
  } finally {
    if (mailer) await mailer.close().catch(() => {});
  }
}

// CALLMEBOT_RECIPIENTS="5511999999999:123456,5511888888888:654321" — um par
// por número, porque a apikey do CallMeBot é vinculada ao número que
// ativou. Mantém CALLMEBOT_PHONE/CALLMEBOT_APIKEY funcionando sozinhos pra
// quem só tem um número.
function callmebotRecipients(env) {
  const multi = (env.CALLMEBOT_RECIPIENTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(':'))
    .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
    .map(([phone, apikey]) => ({ phone: phone.trim(), apikey: apikey.trim() }));
  if (multi.length) return multi;
  if (env.CALLMEBOT_PHONE && env.CALLMEBOT_APIKEY) {
    return [{ phone: env.CALLMEBOT_PHONE, apikey: env.CALLMEBOT_APIKEY }];
  }
  return [];
}

export async function sendWhatsapp(env, message) {
  const recipients = callmebotRecipients(env);
  if (recipients.length === 0) {
    console.log('[alerta] CallMeBot não configurado — ok, é bônus, não é confiável sozinho');
    return;
  }
  await Promise.all(recipients.map(async ({ phone, apikey }) => {
    try {
      const params = new URLSearchParams({ phone, text: message, apikey });
      await fetch(`https://api.callmebot.com/whatsapp.php?${params}`);
    } catch (err) {
      console.log(`[alerta] falha ao enviar WhatsApp via CallMeBot pra ${phone} (esperado, não é confiável): ${err.message}`);
    }
  }));
}

export async function sendAlert(env, providerName, subject, message) {
  const full = `[Vigia | ${providerName}] ${subject}\n\n${message}`;
  console.log(full);
  await Promise.all([sendTelegram(env, full), sendEmail(env, subject, full), sendWhatsapp(env, full)]);
}
