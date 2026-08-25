import {
  checkDnsResolvers,
  checkDnsRegion,
  checkSslReachable,
  checkContent,
  checkUrlIsUp,
  checkInstagramBio,
  checkAdLinkUtms,
  checkSafeBrowsing,
  checkPagespeed,
  type CheckResult,
} from './checks.ts';
import { validateConfig } from './validate.ts';
import { sendAlert } from './alerts.ts';

const PROVIDER_NAME = 'Deno Deploy';

// O Deno Deploy só sobe os arquivos de dentro desta pasta (deno-deploy/),
// então o config.json (que fica um nível acima, compartilhado com os
// outros provedores) não pode ser importado como arquivo local — ele é
// buscado direto do GitHub a cada execução. Bônus: editar o config.json e
// dar push já vale pra esse provedor, sem precisar reimplantar.
//
// Usa o jsdelivr (CDN feito pra servir arquivos de repositórios GitHub),
// não a API do GitHub: a API tem limite de 60 requisições/hora por IP pra
// quem não autentica — em produção, esse limite estourou horas depois do
// primeiro deploy (o IP de saída de plataformas serverless costuma ser
// compartilhado entre muitos clientes). O jsdelivr é um CDN de verdade,
// sem esse tipo de limite.
const CONFIG_URL = Deno.env.get('VIGIA_CONFIG_URL') ??
  'https://cdn.jsdelivr.net/gh/Matheusdearaujo95/Verificador-de-LP@main/config.json';

// deno-lint-ignore no-explicit-any
async function loadConfig(): Promise<any> {
  const resp = await fetch(CONFIG_URL, { headers: { 'cache-control': 'no-cache' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar ${CONFIG_URL}`);
  return await resp.json();
}

function loadEnv(): Record<string, string | undefined> {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CALLMEBOT_PHONE',
    'CALLMEBOT_APIKEY',
    'GOOGLE_API_KEY',
  ];
  const env: Record<string, string | undefined> = {};
  for (const key of keys) env[key] = Deno.env.get(key);
  return env;
}

// deno-lint-ignore no-explicit-any
async function runSiteChecks(site: any, env: Record<string, string | undefined>): Promise<Record<string, CheckResult>> {
  const results: Record<string, CheckResult> = {};

  results.dns_resolvers = await checkDnsResolvers(site.domain, site.expected_ip);
  results.dns_region = await checkDnsRegion(site.domain, site.expected_ip);
  results.ssl = await checkSslReachable(site.domain);

  // deno-lint-ignore no-explicit-any
  for (const check of site.content_checks as any[]) {
    results[`content_${check.device}`] = await checkContent(check.url, check.device, check.expected_texts);
  }

  results.checkout = await checkUrlIsUp(site.checkout_url, 'checkout');

  if (site.instagram_bio_url) {
    results.instagram_bio = await checkInstagramBio(
      site.instagram_bio_url,
      site.instagram_bio_expected_domain || site.domain
    );
  }

  const adLinks = site.ad_links || [];
  for (let i = 0; i < adLinks.length; i++) {
    const key = `ad_link_${i}_${adLinks[i].name || 'sem_nome'}`;
    results[key] = await checkAdLinkUtms(adLinks[i].url);
  }

  if (env.GOOGLE_API_KEY) {
    const homeUrl = `https://${site.domain}/`;
    const urlsToCheck = [...new Set([homeUrl, site.checkout_url])];
    results.safe_browsing = await checkSafeBrowsing(urlsToCheck, env.GOOGLE_API_KEY);

    const pagespeedAlertBelow = site.pagespeed_alert_below ?? 0.5;
    results.pagespeed = await checkPagespeed(homeUrl, env.GOOGLE_API_KEY, pagespeedAlertBelow);
  }

  return results;
}

async function runVigia() {
  const env = loadEnv();

  // deno-lint-ignore no-explicit-any
  let config: any;
  try {
    config = await loadConfig();
  } catch (err) {
    await sendAlert(
      env,
      PROVIDER_NAME,
      'configuração inválida',
      `Não consegui buscar o config.json em ${CONFIG_URL}: ${(err as Error).message}. Nenhuma checagem foi feita.`
    );
    return;
  }

  const problems = validateConfig(config);
  if (problems.length) {
    await sendAlert(
      env,
      PROVIDER_NAME,
      'configuração inválida',
      'config.json tem problemas e nenhuma checagem foi feita:\n- ' + problems.join('\n- ')
    );
    return;
  }

  const kv = await Deno.openKv();
  try {
    for (const site of config.sites) {
      const stateKey = ['vigia', 'site', site.domain];
      const previousEntry = await kv.get<Record<string, { ok: boolean }>>(stateKey);
      const previousState = previousEntry.value ?? {};
      // deno-lint-ignore no-explicit-any
      const newState: Record<string, any> = {};

      const results = await runSiteChecks(site, env);

      for (const [checkKey, result] of Object.entries(results)) {
        const previous = previousState[checkKey];
        if (!previous || previous.ok !== result.ok) {
          const statusWord = result.ok ? 'OK' : 'FALHA';
          await sendAlert(env, PROVIDER_NAME, `${site.name} — ${checkKey}: ${statusWord}`, result.detail);
        }
        newState[checkKey] = { ok: result.ok, detail: result.detail, checked_at: new Date().toISOString() };
      }

      await kv.set(stateKey, newState);
    }
  } finally {
    kv.close();
  }
}

// Descoberto e agendado automaticamente pelo Deno Deploy no deploy — roda
// a cada 15 minutos, igual aos outros provedores.
Deno.cron('vigia', '*/15 * * * *', runVigia);

// Só pra permitir disparar manualmente (teste) e servir de health check.
// A execução de verdade é sempre via Deno.cron acima.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === '/run') {
    await runVigia();
    return new Response('Vigia executado. Veja os logs para detalhes.');
  }
  return new Response('Vigia está de pé. Acesse /run para forçar uma execução manual.');
});
