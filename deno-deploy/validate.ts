// deno-lint-ignore-file no-explicit-any

const REQUIRED_SITE_FIELDS = ['name', 'domain', 'expected_ip', 'checkout_url', 'content_checks'];
const REQUIRED_CONTENT_CHECK_FIELDS = ['device', 'url', 'expected_texts'];
const BAD_TEXT_CHARS = /[←-⇿⌀-➿⬀-⯿\u{1f000}-\u{1faff}]/u;

export function validateConfig(config: any): string[] {
  const problems: string[] = [];

  if (!config || !Array.isArray(config.sites) || config.sites.length === 0) {
    return ["'sites' precisa ser uma lista com pelo menos um site."];
  }

  config.sites.forEach((site: any, i: number) => {
    let label = `site #${i + 1}`;
    if (typeof site !== 'object' || site === null) {
      problems.push(`${label}: não é um objeto válido.`);
      return;
    }
    label = `site '${site.name || label}'`;

    for (const field of REQUIRED_SITE_FIELDS) {
      if (!site[field]) problems.push(`${label}: campo obrigatório '${field}' está vazio ou ausente.`);
    }

    const checks = site.content_checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      problems.push(`${label}: precisa de ao menos um item em 'content_checks'.`);
      return;
    }

    const devicesSeen = new Set<string>();
    checks.forEach((check: any, j: number) => {
      const clabel = `${label}, content_checks #${j + 1}`;
      if (typeof check !== 'object' || check === null) {
        problems.push(`${clabel}: não é um objeto válido.`);
        return;
      }
      for (const field of REQUIRED_CONTENT_CHECK_FIELDS) {
        if (!check[field]) problems.push(`${clabel}: campo obrigatório '${field}' ausente.`);
      }
      if (check.device && check.device !== 'mobile' && check.device !== 'desktop') {
        problems.push(`${clabel}: device '${check.device}' desconhecido (use 'mobile' ou 'desktop').`);
      }
      devicesSeen.add(check.device);
      (check.expected_texts || []).forEach((text: string) => {
        if (BAD_TEXT_CHARS.test(text)) {
          problems.push(
            `${clabel}: texto esperado '${text}' contém seta/ícone/emoji e provavelmente nunca vai bater com o HTML.`
          );
        }
      });
    });

    if (devicesSeen.size === 1) {
      problems.push(
        `${label}: todos os content_checks são do mesmo dispositivo (${[...devicesSeen][0]}) — a outra versão fica sem vigilância.`
      );
    }
  });

  return problems;
}
