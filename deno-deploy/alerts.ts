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

// CALLMEBOT_RECIPIENTS="5511999999999:123456,5511888888888:654321" — um par
// por número, porque a apikey do CallMeBot é vinculada ao número que
// ativou. Mantém CALLMEBOT_PHONE/CALLMEBOT_APIKEY funcionando sozinhos pra
// quem só tem um número.
function callmebotRecipients(env: Record<string, string | undefined>): { phone: string; apikey: string }[] {
  const multi = (env.CALLMEBOT_RECIPIENTS || '')
    .split(/[,;]/)
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

export async function sendWhatsapp(env: Record<string, string | undefined>, message: string) {
  const recipients = callmebotRecipients(env);
  if (recipients.length === 0) {
    console.log('[alerta] CallMeBot não configurado — ok, é bônus, não é confiável sozinho');
    return;
  }
  await Promise.all(
    recipients.map(async ({ phone, apikey }) => {
      try {
        const params = new URLSearchParams({ phone, text: message, apikey });
        await fetch(`https://api.callmebot.com/whatsapp.php?${params}`);
      } catch (err) {
        console.log(`[alerta] falha ao enviar WhatsApp via CallMeBot pra ${phone} (esperado, não é confiável): ${(err as Error).message}`);
      }
    })
  );
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
