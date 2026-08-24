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
    await mailer.send({
      from: { email: env.SMTP_USER },
      to: { email: env.ALERT_EMAIL_TO || env.SMTP_USER },
      subject: `[Vigia] ${subject}`,
      text: message,
    });
  } catch (err) {
    console.log(`[alerta] falha ao enviar e-mail: ${err.message}`);
  } finally {
    if (mailer) await mailer.close().catch(() => {});
  }
}

export async function sendWhatsapp(env, message) {
  if (!env.CALLMEBOT_PHONE || !env.CALLMEBOT_APIKEY) {
    console.log('[alerta] CallMeBot não configurado — ok, é bônus, não é confiável sozinho');
    return;
  }
  try {
    const params = new URLSearchParams({
      phone: env.CALLMEBOT_PHONE,
      text: message,
      apikey: env.CALLMEBOT_APIKEY,
    });
    await fetch(`https://api.callmebot.com/whatsapp.php?${params}`);
  } catch (err) {
    console.log(`[alerta] falha ao enviar WhatsApp via CallMeBot (esperado, não é confiável): ${err.message}`);
  }
}

export async function sendAlert(env, providerName, subject, message) {
  const full = `[Vigia | ${providerName}] ${subject}\n\n${message}`;
  console.log(full);
  await Promise.all([sendTelegram(env, full), sendEmail(env, subject, full), sendWhatsapp(env, full)]);
}
