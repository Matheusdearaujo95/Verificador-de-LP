// Neste provedor, e-mail via SMTP NÃO é enviado: o Deno Deploy bloqueia as
// portas de saída 25, 465 e 587 pra todo mundo (anti-spam da plataforma),
// então SMTP direto simplesmente não funciona aqui, não importa a
// biblioteca. Telegram e WhatsApp continuam normais. E-mail continua
// coberto pelos outros 4 provedores (GitHub Actions, Cloudflare Workers,
// Google Cloud Functions, Oracle).

export async function sendTelegram(env: Record<string, string | undefined>, message: string) {
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
    console.log(`[alerta] falha ao enviar Telegram: ${(err as Error).message}`);
  }
}

export async function sendWhatsapp(env: Record<string, string | undefined>, message: string) {
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
    console.log(`[alerta] falha ao enviar WhatsApp via CallMeBot (esperado, não é confiável): ${(err as Error).message}`);
  }
}

export async function sendAlert(
  env: Record<string, string | undefined>,
  providerName: string,
  subject: string,
  message: string
) {
  const full = `[Vigia | ${providerName}] ${subject}\n\n${message}`;
  console.log(full);
  await Promise.all([sendTelegram(env, full), sendWhatsapp(env, full)]);
}
