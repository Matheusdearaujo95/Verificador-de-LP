import {
  checkDnsResolvers,
  checkDnsRegion,
  checkSslReachable,
  checkContent,
  checkUrlIsUp,
  checkInstagramBio,
  checkAdLinkUtms,
} from './checks.js';
import { validateConfig } from './validate.js';
import { sendAlert } from './alerts.js';

const PROVIDER_NAME = 'Cloudflare Workers';

// Assim como no Deno Deploy, o config.json não fica "gravado" dentro do
// Worker — é buscado ao vivo do GitHub a cada execução. Editar o
// config.json (pelo editor.html) e subir pro GitHub já vale aqui, sem
// precisar rodar `wrangler deploy` de novo.
const DEFAULT_CONFIG_URL =
  'https://api.github.com/repos/Matheusdearaujo95/Verificador-de-LP/contents/config.json?ref=main';

async function loadConfig(env) {
  const url = env.VIGIA_CONFIG_URL || DEFAULT_CONFIG_URL;
  const resp = await fetch(url, {
    headers: {
      accept: 'application/vnd.github.raw+json',
      'cache-control': 'no-cache',
      'user-agent': 'vigia-cloudflare-worker',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar ${url}`);
  return await resp.json();
}

async function runSiteChecks(site) {
  const results = {};

  results.dns_resolvers = await checkDnsResolvers(site.domain, site.expected_ip);
  results.dns_region = await checkDnsRegion(site.domain, site.expected_ip);
  results.ssl = await checkSslReachable(site.domain);

  for (const check of site.content_checks) {
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

async function runVigia(env) {
  let config;
  try {
    config = await loadConfig(env);
  } catch (err) {
    await sendAlert(
      env,
      PROVIDER_NAME,
      'configuração inválida',
      `Não consegui buscar o config.json: ${err.message}. Nenhuma checagem foi feita.`
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

  for (const site of config.sites) {
    const stateKey = `site:${site.domain}`;
    const previousRaw = await env.VIGIA_STATE.get(stateKey);
    const previousState = previousRaw ? JSON.parse(previousRaw) : {};
    const newState = {};

    const results = await runSiteChecks(site);

    for (const [checkKey, result] of Object.entries(results)) {
      const previous = previousState[checkKey];
      if (!previous || previous.ok !== result.ok) {
        const statusWord = result.ok ? 'OK' : 'FALHA';
        await sendAlert(env, PROVIDER_NAME, `${site.name} — ${checkKey}: ${statusWord}`, result.detail);
      }
      newState[checkKey] = { ok: result.ok, detail: result.detail, checked_at: new Date().toISOString() };
    }

    await env.VIGIA_STATE.put(stateKey, JSON.stringify(newState));
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runVigia(env));
  },
  // Permite disparar manualmente abrindo a URL do Worker no navegador —
  // só pra testar; a execução de verdade é sempre via Cron Trigger.
  async fetch(request, env, ctx) {
    await runVigia(env);
    return new Response('Vigia executado. Veja os logs (wrangler tail) para detalhes.');
  },
};
