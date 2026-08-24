import config from '../config.json' with { type: 'json' };
import {
  checkDnsResolvers,
  checkDnsRegion,
  checkSslReachable,
  checkContent,
  checkUrlIsUp,
  checkInstagramBio,
  checkAdLinkUtms,
  type CheckResult,
} from './checks.ts';
import { validateConfig } from './validate.ts';
import { sendAlert } from './alerts.ts';

const PROVIDER_NAME = 'Deno Deploy';

function loadEnv(): Record<string, string | undefined> {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CALLMEBOT_PHONE',
    'CALLMEBOT_APIKEY',
  ];
  const env: Record<string, string | undefined> = {};
  for (const key of keys) env[key] = Deno.env.get(key);
  return env;
}

// deno-lint-ignore no-explicit-any
async function runSiteChecks(site: any): Promise<Record<string, CheckResult>> {
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

  return results;
}

async function runVigia() {
  const env = loadEnv();
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

      const results = await runSiteChecks(site);

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
