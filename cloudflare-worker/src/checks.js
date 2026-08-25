import { resolveA } from './dns.js';

const REQUEST_TIMEOUT_MS = 15000;

const DEVICE_USER_AGENTS = {
  mobile:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

// Yandex e Level3 ficam de fora: nenhum dos dois tem um endpoint DoH
// público confiável hoje. Continuam cobertos nos provedores em Python
// (GitHub Actions, Google Cloud Functions, Oracle), que consultam DNS bruto
// via UDP e não dependem de DoH.
export const DOH_RESOLVERS = {
  Google: 'https://dns.google/dns-query',
  Cloudflare: 'https://cloudflare-dns.com/dns-query',
  Quad9: 'https://dns.quad9.net/dns-query',
  OpenDNS: 'https://doh.opendns.com/dns-query',
  AdGuard: 'https://dns.adguard-dns.com/dns-query',
};

export const ECS_REGIONS = {
  'São Paulo': '200.221.0.0/24',
  'Rio de Janeiro': '200.223.0.0/24',
  Nordeste: '200.199.0.0/24',
  EUA: '8.8.8.0/24',
  Europa: '185.60.216.0/24',
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tempo esgotado')), ms)),
  ]);
}

export async function checkDnsResolvers(domain, expectedIp) {
  const results = {};
  const errors = [];
  await Promise.all(
    Object.entries(DOH_RESOLVERS).map(async ([name, endpoint]) => {
      try {
        const ips = await withTimeout(resolveA(endpoint, domain), REQUEST_TIMEOUT_MS);
        results[name] = ips.slice().sort();
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    })
  );

  if (errors.length && Object.keys(results).length === 0) {
    return { ok: false, detail: `todos os resolvedores falharam: ${errors.join('; ')}` };
  }

  const distinct = new Set(Object.values(results).map((ips) => ips.join(',')));
  const problems = [];
  if (distinct.size > 1) problems.push(`resolvedores divergem entre si: ${JSON.stringify(results)}`);
  for (const [name, ips] of Object.entries(results)) {
    if (!ips.includes(expectedIp)) problems.push(`${name} respondeu ${ips}, esperado ${expectedIp}`);
  }
  if (errors.length) problems.push(`falharam: ${errors.join('; ')}`);

  if (problems.length) return { ok: false, detail: problems.join(' | ') };
  return {
    ok: true,
    detail: `todos os ${Object.keys(results).length} resolvedores concordam em ${expectedIp}`,
  };
}

export async function checkDnsRegion(domain, expectedIp) {
  const problems = [];
  const okRegions = [];
  await Promise.all(
    Object.entries(ECS_REGIONS).map(async ([region, subnet]) => {
      try {
        const ips = await withTimeout(
          resolveA(DOH_RESOLVERS.Google, domain, subnet),
          REQUEST_TIMEOUT_MS
        );
        if (ips.includes(expectedIp)) okRegions.push(region);
        else problems.push(`${region} (${subnet}) recebeu ${JSON.stringify(ips)}`);
      } catch (err) {
        problems.push(`${region} (${subnet}): erro ao consultar — ${err.message}`);
      }
    })
  );
  if (problems.length) return { ok: false, detail: problems.join(' | ') };
  return { ok: true, detail: `IP esperado confirmado em: ${okRegions.join(', ')}` };
}

export async function checkSslReachable(domain) {
  // Workers não expõe a data de validade do certificado (sem API de
  // inspeção de TLS). Aqui só confirmamos que o handshake HTTPS é aceito,
  // o que já pega certificado vencido/inválido/errado. O aviso "vence em
  // N dias" fica por conta dos provedores em Python (GitHub Actions,
  // Google Cloud Functions, Oracle).
  try {
    const resp = await withTimeout(
      fetch(`https://${domain}/`, { method: 'HEAD' }),
      REQUEST_TIMEOUT_MS
    );
    return {
      ok: true,
      detail: `handshake HTTPS OK (HTTP ${resp.status}) — validade em dias só é checada nos provedores Python`,
    };
  } catch (err) {
    return { ok: false, detail: `handshake HTTPS falhou (certificado inválido/vencido?): ${err.message}` };
  }
}

function normalizeWhitespace(text) {
  return text.replace(/&nbsp;/g, ' ').replace(/ /g, ' ');
}

export async function checkContent(url, device, expectedTexts) {
  try {
    const resp = await withTimeout(
      fetch(url, { headers: { 'User-Agent': DEVICE_USER_AGENTS[device] || DEVICE_USER_AGENTS.desktop } }),
      REQUEST_TIMEOUT_MS
    );
    if (resp.status >= 400) return { ok: false, detail: `${url} respondeu HTTP ${resp.status}` };
    const html = normalizeWhitespace(await resp.text());
    const missing = expectedTexts.filter((t) => !html.includes(normalizeWhitespace(t)));
    if (missing.length) {
      return { ok: false, detail: `textos ausentes no HTML (${device}): ${JSON.stringify(missing)}` };
    }
    return { ok: true, detail: `todos os ${expectedTexts.length} textos encontrados (${device})` };
  } catch (err) {
    return { ok: false, detail: `erro ao acessar ${url}: ${err.message}` };
  }
}

export async function checkUrlIsUp(url, label) {
  try {
    const resp = await withTimeout(fetch(url, { redirect: 'follow' }), REQUEST_TIMEOUT_MS);
    if (resp.status >= 400) return { ok: false, detail: `${label} respondeu HTTP ${resp.status}` };
    return { ok: true, detail: `${label} no ar (HTTP ${resp.status})` };
  } catch (err) {
    return { ok: false, detail: `erro ao acessar ${label}: ${err.message}` };
  }
}

export async function checkInstagramBio(url, expectedDomain) {
  try {
    const resp = await withTimeout(fetch(url, { redirect: 'follow' }), REQUEST_TIMEOUT_MS);
    const finalDomain = new URL(resp.url).hostname;
    if (!finalDomain.includes(expectedDomain)) {
      return {
        ok: false,
        detail: `link da bio terminou em '${finalDomain}', esperado '${expectedDomain}'`,
      };
    }
    if (resp.status >= 400) return { ok: false, detail: `link da bio respondeu HTTP ${resp.status}` };
    return { ok: true, detail: `link da bio termina em ${finalDomain}` };
  } catch (err) {
    return { ok: false, detail: `erro ao acessar link da bio: ${err.message}` };
  }
}

export async function checkAdLinkUtms(url) {
  const originalParams = new URL(url).searchParams;
  const expectedUtms = {};
  for (const [key, value] of originalParams) {
    if (key.startsWith('utm_')) expectedUtms[key] = value;
  }
  if (Object.keys(expectedUtms).length === 0) {
    return { ok: false, detail: 'URL de anúncio não tem nenhum parâmetro utm_* para checar' };
  }
  try {
    const resp = await withTimeout(fetch(url, { redirect: 'follow' }), REQUEST_TIMEOUT_MS);
    const finalParams = new URL(resp.url).searchParams;
    const lost = [];
    const changed = [];
    for (const [key, value] of Object.entries(expectedUtms)) {
      const finalValue = finalParams.get(key);
      if (finalValue === null) lost.push(key);
      else if (finalValue !== value) changed.push(`${key}: '${value}' -> '${finalValue}'`);
    }
    if (lost.length || changed.length) {
      const problems = [];
      if (lost.length) problems.push(`parâmetros perdidos no redirect: ${JSON.stringify(lost)}`);
      if (changed.length) problems.push(`parâmetros alterados: ${JSON.stringify(changed)}`);
      return { ok: false, detail: problems.join(' | ') };
    }
    return {
      ok: true,
      detail: `todos os ${Object.keys(expectedUtms).length} UTMs sobreviveram até ${resp.url}`,
    };
  } catch (err) {
    return { ok: false, detail: `erro ao seguir redirecionamento: ${err.message}` };
  }
}

const SAFE_BROWSING_THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION',
];

export async function checkSafeBrowsing(urls, apiKey) {
  const body = {
    client: { clientId: 'vigia-monitor', clientVersion: '1.0' },
    threatInfo: {
      threatTypes: SAFE_BROWSING_THREAT_TYPES,
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: urls.map((url) => ({ url })),
    },
  };
  try {
    const resp = await withTimeout(
      fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      REQUEST_TIMEOUT_MS
    );
    if (!resp.ok) return { ok: false, detail: `Safe Browsing respondeu HTTP ${resp.status}` };
    const data = await resp.json();
    const matches = data.matches || [];
    if (matches.length) {
      const found = [...new Set(matches.map((m) => `${m.threat?.url ?? '?'} (${m.threatType ?? '?'})`))].sort();
      return { ok: false, detail: `Google Safe Browsing encontrou problema: ${found.join(', ')}` };
    }
    return {
      ok: true,
      detail: `nenhuma URL marcada como phishing/malware pelo Google Safe Browsing (${urls.length} verificadas)`,
    };
  } catch (err) {
    return { ok: false, detail: `erro ao consultar o Google Safe Browsing: ${err.message}` };
  }
}

export async function checkPagespeed(url, apiKey, alertBelow) {
  try {
    const params = new URLSearchParams({ url, key: apiKey, strategy: 'mobile', category: 'performance' });
    const resp = await withTimeout(
      fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`),
      90000
    );
    if (!resp.ok) return { ok: false, detail: `PageSpeed Insights respondeu HTTP ${resp.status}` };
    const data = await resp.json();
    const score = data.lighthouseResult.categories.performance.score;
    const scorePct = Math.round(score * 100);
    if (score < alertBelow) {
      return {
        ok: false,
        detail: `nota de performance (mobile) caiu pra ${scorePct}/100, abaixo do limite de ${Math.round(alertBelow * 100)}`,
      };
    }
    return { ok: true, detail: `nota de performance (mobile): ${scorePct}/100` };
  } catch (err) {
    return { ok: false, detail: `erro ao consultar o PageSpeed Insights: ${err.message}` };
  }
}
