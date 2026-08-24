# Vigia

Monitor de disponibilidade do Acervo do Nutri (e de outros sites que você
cadastrar depois). Roda de forma independente em 4 provedores gratuitos,
sem servidor próprio, sem banco de dados central. Se um provedor cair ou
mudar de política, os outros três continuam avisando sozinhos.

**Status atual: 4 provedores rodando de verdade, testados um por um.**

| Provedor | O que faz de diferente | Alertas |
|---|---|---|
| **GitHub Actions** | DNS bruto em 7 resolvedores, SSL com validade em dias | Telegram, e-mail, WhatsApp |
| **Cloudflare Workers** | DNS via DoH em 5 resolvedores, SSL só alcançabilidade | Telegram, e-mail, WhatsApp |
| **Deno Deploy** | Igual ao Cloudflare, config buscado ao vivo no GitHub | Telegram, WhatsApp (**sem e-mail** — Deno bloqueia SMTP) |
| **Google Cloud Functions** | DNS bruto em 7 resolvedores, SSL com validade em dias | Telegram, e-mail, WhatsApp |

Todos os quatro leem o mesmo [`config.json`](config.json) e checam:
DNS (múltiplos resolvedores + simulação regional via EDNS Client Subnet),
certificado SSL, conteúdo da LP (mobile e desktop), checkout, link da bio
do Instagram, e sobrevivência dos parâmetros UTM em links de anúncio. Só
alertam quando o estado **muda** (nunca repete o mesmo alerta a cada
execução).

## Arquivos

- [`config.json`](config.json) — o que monitorar. Edite pelo
  [`editor.html`](editor.html) (abra localmente no navegador, não precisa
  de servidor), não à mão.
- [`monitor.py`](monitor.py) — lógica de checagem em Python, usada por
  GitHub Actions, Google Cloud Functions e (se configurar) uma VM própria.
- [`main.py`](main.py) — porta de entrada HTTP do Cloud Functions (chama o
  `monitor.py`).
- [`cloudflare-worker/`](cloudflare-worker) e [`deno-deploy/`](deno-deploy)
  — a mesma lógica reescrita em JavaScript/TypeScript (Workers e Deno não
  rodam Python).
- [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml) — cron
  do GitHub Actions.
- [`deploy-gcf.sh`](deploy-gcf.sh) — script de referência com todos os
  comandos `gcloud` usados pra publicar no Google Cloud (não roda sozinho,
  é pra copiar e colar linha a linha se precisar recriar do zero).

## Editando o que é monitorado

Abra o [`editor.html`](editor.html) direto no navegador (duplo clique no
arquivo). Ele:
- Mostra os campos em português simples, com um ícone de ajuda (i) em cada um.
- Tem uma caixa "colar código-fonte da página": copie o HTML da LP
  (Ctrl+U na página → Ctrl+A → Ctrl+C) e cole lá — ele tenta detectar
  sozinho o domínio, o link de checkout e os textos de botão, mas nunca
  preenche nada sem você clicar em "Está certo".
- Avisa em tempo real se algo ficou incompleto ou ambíguo.
- Gera o `config.json` final (botão Copiar ou Baixar).

Depois de editar, **suba o `config.json` novo pro GitHub** — só isso.
Os 4 provedores buscam o config direto do GitHub a cada execução (nenhum
fica com uma cópia "gravada" no deploy), então não precisa reimplantar
nada nos outros três depois de editar.

## Credenciais usadas

- **Telegram**: bot criado via [@BotFather](https://t.me/BotFather)
  (`/newbot`), `chat_id` obtido em
  `https://api.telegram.org/bot<TOKEN>/getUpdates` depois de mandar uma
  mensagem pro bot.
- **E-mail**: Gmail com [senha de app](https://myaccount.google.com/apppasswords)
  (precisa de verificação em duas etapas ativada). `ALERT_EMAIL_TO` aceita
  mais de um endereço, separados por `,` ou `;`.
- **WhatsApp (CallMeBot)**: mande `I allow callmebot to send me messages`
  pro número **+34 644 59 71 67** pra cada número que quiser cadastrar,
  ele responde com uma apikey. Formato:
  `CALLMEBOT_RECIPIENTS=+55DDDNUMERO:apikey1,+55DDDNUMERO2:apikey2`
  (números brasileiros: teste com e sem o 9 extra — o CallMeBot às vezes
  só reconhece sem). Não é confiável sozinho (mantido por hobby, sujeito a
  fila/atraso) — Telegram e e-mail são a base, WhatsApp é bônus.

⚠️ **No Google Cloud especificamente**, use `;` em vez de `,` dentro dos
valores de `ALERT_EMAIL_TO` e `CALLMEBOT_RECIPIENTS`, porque o `gcloud` já
usa vírgula pra separar variáveis entre si. O `monitor.py` aceita os dois
separadores em qualquer provedor.

## Onde cada secret é cadastrado

- **GitHub**: `Settings → Secrets and variables → Actions` no repositório.
- **Cloudflare**: `wrangler secret put NOME` (dentro de `cloudflare-worker/`).
- **Deno Deploy**: `deno deploy env add NOME VALOR --org ... --app ...` (não usa e-mail).
- **Google Cloud**: `--update-env-vars` no `gcloud functions deploy` (ver `deploy-gcf.sh`).

Nomes usados em todos: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO`,
`CALLMEBOT_RECIPIENTS` (Deno Deploy não usa os 4 de e-mail).

## Limitações conhecidas (por design, não bugs)

- **SSL com validade em dias** só é checado nos provedores em Python
  (GitHub Actions, Google Cloud Functions) — Workers e Deno não expõem
  essa informação, só confirmam que o HTTPS responde.
- **7 resolvedores DNS** só nos provedores Python (DNS bruto via UDP).
  Workers e Deno usam 5 (via DoH — Yandex e Level3 não têm endpoint DoH
  público confiável).
- **Deno Deploy não manda e-mail** — a plataforma bloqueia as portas
  25/465/587 pra todo mundo, sem exceção.
- É esperado (e correto) receber o mesmo alerta de mais de um provedor
  quando algo realmente quebra — é a prova de que a redundância funciona.

## Se algum dia quiser adicionar um 5º provedor (VM própria)

A Oracle Cloud era a candidata natural (Always Free, região São Paulo),
mas o cadastro deu erro na criação da conta. Se quiser tentar de novo (ou
usar outra VM, incluindo a e2-micro grátis do Compute Engine dentro da
conta Google Cloud que já existe aqui), o processo é:
1. Criar a VM, instalar Python 3.12 e `git`.
2. Clonar este repositório.
3. `pip install -r requirements.txt`.
4. Configurar as variáveis de ambiente (as mesmas da tabela acima) num
   arquivo `.env` carregado pelo cron, ou exportadas no `crontab -e`.
5. `*/15 * * * * cd /caminho/do/repo && VIGIA_PROVIDER_NAME="nome-da-vm" python3 monitor.py >> /var/log/vigia.log 2>&1`

## Segurança

Durante a configuração deste projeto, alguns valores sensíveis (token do
Telegram, senha de app do Gmail, apikeys do CallMeBot, um token do Deno
Deploy) foram colados em texto puro numa conversa de chat. Nenhum desses
valores está neste repositório nem em nenhum arquivo do projeto — mas como
boa prática, vale revogar e gerar novos:
- Telegram: fale com o @BotFather e peça `/revoke` (ou `/token` pra pedir um novo).
- Gmail: revogue a senha de app antiga em myaccount.google.com/apppasswords e gere outra.
- CallMeBot: risco baixo (na pior hipótese, spam no seu próprio WhatsApp), mas pode reativar com uma apikey nova a qualquer momento.
- Deno Deploy: gere um novo token em console.deno.com (Settings → Access Tokens) e revogue o antigo.
