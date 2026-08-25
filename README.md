# Vigia

Monitor de disponibilidade de landing pages, criado depois de um problema
real: o site `acervodonutri.com` ficou inacessível pra parte dos
visitantes por causa de um CDN da Hostinger entregando IPs rotativos com
TTL de 60 segundos — alguns clientes conseguiam abrir o site, outros não,
de forma intermitente, sem ninguém perceber até um cliente reclamar. A
causa específica já foi corrigida (CDN desligado), mas o Vigia existe pra
nunca mais depender de "um cliente avisar" pra descobrir que algo quebrou.

**Status atual: 4 provedores rodando de verdade, cada um testado
individualmente com falha forçada e recuperação real.**

## Por que essa arquitetura

- **Sem servidor próprio, sem banco de dados.** Só um script que roda,
  compara com a última execução, e alerta se algo mudou.
- **4 provedores gratuitos e independentes** (GitHub Actions, Cloudflare
  Workers, Deno Deploy, Google Cloud Functions), cada um rodando a cada 15
  minutos, sem se comunicar entre si. Se um provedor sair do ar, mudar de
  política de preço, ou simplesmente tiver uma falha de rede pontual
  (aconteceu durante os testes — ver seção de Troubleshooting), os outros
  três continuam avisando sozinhos.
- **É esperado (e correto) receber o mesmo alerta de mais de uma fonte**
  quando algo realmente quebra — isso é a prova de que a redundância
  funciona, não um bug.
- **DNS de múltiplos resolvedores e regiões** é o motivo do script
  existir: serviços prontos como UptimeRobot e Site24x7 (ambos também
  cadastrados, como camada extra gratuita) verificam "o site está no ar",
  mas nenhum verifica DNS a partir de múltiplas regiões — que foi
  exatamente a causa raiz do problema real que originou este projeto.

## O que cada checagem faz

Pra cada site cadastrado no `config.json`:

1. **DNS em múltiplos resolvedores públicos** (Google, Cloudflare, Quad9,
   OpenDNS, AdGuard, e mais Level3/Yandex nos provedores em Python) —
   alerta se as respostas divergirem entre si ou do IP esperado.
2. **DNS "visto de uma região"**, via EDNS Client Subnet (ECS) — simula a
   consulta como se viesse de São Paulo, Rio, Nordeste, EUA e Europa, sem
   precisar de servidor físico em cada lugar. Usa o resolvedor público do
   Google, que documenta suporte a esse parâmetro.
3. **Certificado SSL** — validade, com aviso configurável (padrão 20 dias
   antes do vencimento). Só nos provedores em Python — ver Limitações.
4. **Conteúdo da LP**, verificado separadamente pra mobile e desktop —
   confirma que os textos exatos dos botões de compra existem no HTML
   bruto (não inferido visualmente), incluindo o link de checkout como um
   dos "textos obrigatórios" (detecta se o botão parou de apontar pra lá).
5. **Checkout** — confirma que o link de pagamento está no ar.
6. **Link da bio do Instagram** — resolve, e termina no domínio certo.
7. **Link(s) de anúncio com UTM** — segue o redirecionamento inteiro e
   confirma que os parâmetros (`utm_source`, `utm_medium`, `utm_campaign`,
   `utm_content`, `utm_term`) sobrevivem até o destino final. O risco real
   não é o link cair, é o site descartar os parâmetros no redirect,
   fazendo a venda acontecer sem se saber a origem.

Alerta só dispara quando o estado de uma checagem **muda** (ok→falha ou
falha→ok) — nunca repete o mesmo alerta a cada execução enquanto o
problema persiste.

## Os 4 provedores

| Provedor | Executa | Estado guardado em | DNS | SSL | E-mail |
|---|---|---|---|---|---|
| **GitHub Actions** | `monitor.py` direto | `state.json`, commitado de volta no repo | 7 resolvedores (UDP bruto) | validade em dias | sim |
| **Cloudflare Workers** | `cloudflare-worker/src/worker.js` | Workers KV | 5 resolvedores (DoH) | só alcançabilidade | sim (via `worker-mailer`, sockets TCP nativos) |
| **Deno Deploy** | `deno-deploy/main.ts` | Deno KV | 5 resolvedores (DoH) | só alcançabilidade | **não** — Deno Deploy bloqueia as portas 25/465/587 pra todo mundo, sem exceção |
| **Google Cloud Functions** | `main.py` → `monitor.py` | bucket no Cloud Storage | 7 resolvedores (UDP bruto) | validade em dias | sim |

Todos os 4 buscam o `config.json` **ao vivo do GitHub** a cada execução,
via CDN do jsdelivr (não a API do GitHub nem `raw.githubusercontent.com`
direto — ver Troubleshooting pra entender por quê).
Nenhum fica com uma cópia "gravada" no deploy, então editar o
`config.json` e subir pro GitHub já vale em todos, sem redeploy.

### Redeployar depois de mudar o *código* (não o config)

Mudar o `config.json` nunca precisa disso — só se você editar a lógica em
`monitor.py`, `cloudflare-worker/src/*.js` ou `deno-deploy/*.ts`.

- **GitHub Actions**: nada a fazer, o próximo cron já usa a versão nova do repositório.
- **Cloudflare Workers**: `cd cloudflare-worker && npm install && npx wrangler deploy`
- **Deno Deploy**: `cd deno-deploy && export DENO_DEPLOY_TOKEN=... && deno deploy --org matheusdearaujo95 --app vigia-acervodonutri --prod --non-interactive`
- **Google Cloud Functions**: `cd vigia && gcloud functions deploy vigia-acervodonutri --gen2 --region=southamerica-east1 --project=project-5066600a-9a75-4198-a04 --source=.`

## Estrutura de arquivos

```
vigia/
├── config.json              # o que monitorar (edite pelo editor.html)
├── editor.html               # ferramenta local pra gerar/editar o config.json
├── monitor.py                 # lógica de checagem em Python
├── requirements.txt            # dependências Python
├── main.py                     # entrada HTTP do Cloud Functions (chama monitor.py)
├── deploy-gcf.sh                # comandos de referência do Google Cloud (não roda sozinho)
├── .gcloudignore                 # exclui os outros provedores do upload pro GCF
├── state.json                     # estado do GitHub Actions (commitado automaticamente)
├── .github/workflows/monitor.yml   # cron do GitHub Actions
├── cloudflare-worker/
│   ├── wrangler.toml                # config do Worker (nome, cron, KV namespace)
│   ├── package.json / package-lock.json
│   └── src/
│       ├── worker.js                 # ponto de entrada (scheduled + fetch)
│       ├── checks.js                  # as 7 checagens
│       ├── dns.js                      # cliente DNS-over-HTTPS escrito à mão
│       ├── validate.js                  # validação do config.json
│       └── alerts.js                     # Telegram / e-mail / WhatsApp
└── deno-deploy/
    ├── deno.jsonc                    # org/app do Deno Deploy (sem segredos)
    ├── main.ts                        # ponto de entrada (Deno.cron + Deno.serve)
    ├── checks.ts / dns.ts / validate.ts / alerts.ts   # mesma lógica em TypeScript
```

## `editor.html` — como editar o que é monitorado

Abra o arquivo direto no navegador (duplo clique) — não precisa de
servidor, nada é enviado pra lugar nenhum, roda inteiro no seu navegador.
Também pode ser hospedado como arquivo estático (ex: numa pasta
`acervodonutri.com/vigia/` na Hostinger) só pra acessar de qualquer
lugar — continua sem se conectar a nada.

- **Abas por site** — um site por aba, todos exportados juntos num único `config.json`.
- **Campos em português simples**, com um ícone de ajuda (i, tooltip) explicando o que preencher e onde achar a informação.
- **Caixa de colar código-fonte**: abra a LP, Ctrl+U (ver código-fonte), Ctrl+A, Ctrl+C, cole na caixa, clique em Analisar. Ele tenta identificar sozinho:
  - o domínio canônico da página,
  - o link de checkout (domínio externo mais repetido, priorizando gateways conhecidos: Kiwify, Hotmart, Eduzz, Monetizze, Braip, PerfectPay, Stripe, Mercado Pago, etc.),
  - os textos de botão que apontam pra esse checkout (ignorando ícones/setas decorativas dentro do próprio botão).
  - Cada achado aparece com **"Está certo" / "Corrigir à mão"** — nunca preenche nada sozinho sem confirmação, e confirmar um achado não apaga os outros ainda não confirmados.
  - Detecta e avisa sobre **textos ambíguos** (mesmo texto, destinos diferentes — ex: "Começar agora" que aparece 2x na página) em vez de incluir ou excluir silenciosamente.
  - Limpa parâmetros de rastreamento (`utm_*`, `sck`, `fbclid`, `gclid`, `ttclid`) do link de checkout detectado.
- **Validação em tempo real**: avisa se falta domínio, IP, link de checkout, texto esperado, se um texto tem seta/ícone/emoji (nunca vai bater com o HTML), ou se só um dispositivo (mobile ou desktop) tem texto cadastrado.
- **Copiar** e **Baixar** o `config.json` final.
- **Carregar existente** pra reabrir um config já salvo e continuar editando.

### Campos do `config.json` por site

| Campo | Obrigatório | O que é |
|---|---|---|
| `name` | sim | nome só pra identificar nos alertas |
| `domain` | sim | domínio principal, sem `https://` |
| `expected_ip` | sim | IP que o domínio deveria resolver (veja em whatsmydns.net) |
| `checkout_url` | sim | link do checkout, sem parâmetros de rastreamento |
| `ssl_alert_days` | não (padrão 20) | dias de antecedência pro aviso de SSL vencendo |
| `content_checks` | sim, pelo menos 1 mobile + 1 desktop | `{device, url, expected_texts[]}` |
| `instagram_bio_url` | não | link completo que está na bio |
| `instagram_bio_expected_domain` | não (usa `domain` se vazio) | domínio esperado ao final do redirecionamento |
| `ad_links` | não | lista de `{name, url}` com UTMs pra checar |

## Credenciais

### Telegram (canal principal)
1. Fale com [@BotFather](https://t.me/BotFather), mande `/newbot`, escolha nome e username.
2. Guarde o **token** que ele devolve.
3. Mande uma mensagem qualquer pro bot que você criou.
4. Acesse `https://api.telegram.org/bot<TOKEN>/getUpdates` no navegador — o número depois de `"chat":{"id":` é o **chat_id**.
   - Se vier `"result":[]`, é porque a mensagem ainda não foi "vista" — mande de novo e recarregue a página.

### E-mail (segunda camada, via SMTP direto)
1. Ative a verificação em duas etapas na conta Gmail remetente.
2. Gere uma senha de app em `myaccount.google.com/apppasswords`.
3. `ALERT_EMAIL_TO` aceita mais de um destinatário, separados por `,` ou `;` — não precisa de senha nenhuma pro lado de quem só recebe.

### WhatsApp via CallMeBot (bônus, não confiável sozinho)
1. Salve o número **+34 644 59 71 67** no WhatsApp.
2. Mande a mensagem exata `I allow callmebot to send me messages`, pra cada número que quiser cadastrar.
3. Ele responde com uma **apikey**.
4. Formato: `CALLMEBOT_RECIPIENTS=+55DDDNUMERO:apikey1,+55DDDNUMERO2:apikey2`
   - **Números brasileiros**: teste com e sem o 9º dígito — na prática, o CallMeBot só reconheceu a versão *sem* o 9 extra num dos testes feitos aqui.
   - **Limite de taxa**: até 16 mensagens a cada 240 minutos por número; acima disso, as mensagens ficam na fila e chegam atrasadas (não é erro, é o próprio serviço avisando isso na resposta).
   - Se algum dia o volume justificar, o upgrade correto é pra API oficial da Meta (WhatsApp Cloud API) — exige aprovação de template pra mensagens fora da janela de 24h.

⚠️ **No Google Cloud especificamente**, use `;` em vez de `,` dentro dos
valores de `ALERT_EMAIL_TO` e `CALLMEBOT_RECIPIENTS` — o `gcloud` já usa
vírgula pra separar variáveis entre si dentro do mesmo `--update-env-vars`.
O `monitor.py` e as versões JS/TS aceitam os dois separadores em qualquer
provedor, então usar `;` em todo lugar por padrão também funciona.

## Onde cada secret é cadastrado

| Provedor | Comando |
|---|---|
| GitHub | `Settings → Secrets and variables → Actions → New repository secret` no repositório (interface web) |
| Cloudflare | `wrangler secret put NOME` (dentro de `cloudflare-worker/`, pede o valor de forma oculta) |
| Deno Deploy | `deno deploy env add NOME VALOR --org matheusdearaujo95 --app vigia-acervodonutri --non-interactive` (ou `env load arquivo.env`) — **e-mail não se aplica aqui** |
| Google Cloud | `gcloud functions deploy vigia-acervodonutri --gen2 --region=southamerica-east1 --project=project-5066600a-9a75-4198-a04 --update-env-vars="NOME=valor,..."` |

Nomes usados: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO`,
`CALLMEBOT_RECIPIENTS` (Deno Deploy não usa os 4 de e-mail).

**Importante em qualquer provedor**: depois de cadastrar/editar secrets
num app que já estava rodando, algumas plataformas (percebido no Deno
Deploy) só aplicam a mudança numa **implantação nova** — pode ser
necessário reimplantar mesmo sem ter mudado nada no código, só pra pegar
o secret novo.

## Adicionando um novo site

Nenhum secret é por-site (Telegram, e-mail, WhatsApp já valem pra
qualquer site cadastrado), então adicionar um site novo é só editar o
`config.json` e subir a versão nova pro GitHub — sem mexer em nenhum
provedor.

### Passo 1 — pegar o `config.json` atual

O `editor.html` abre em branco, sozinho ele não sabe o que já está
cadastrado — então primeiro baixe o arquivo atual do GitHub:

1. Acesse `github.com/Matheusdearaujo95/Verificador-de-LP/blob/main/config.json`
2. Clique no ícone de download (uma seta pra baixo, geralmente no canto
   superior direito do conteúdo do arquivo) — ou clique em "Raw" e depois
   Ctrl+S (Cmd+S no Mac) pra salvar a página como arquivo.
3. Guarde esse arquivo em algum lugar que você lembre (ex: Desktop).

### Passo 2 — editar no `editor.html`

1. Abra o `editor.html` no navegador.
2. Clique em **"Carregar existente"** e selecione o `config.json` que
   você acabou de baixar — as abas dos sites já cadastrados vão aparecer
   preenchidas.
3. Clique em **"+ Novo site"** — uma aba nova em branco aparece.
4. Preencha os campos (nome, domínio, IP esperado, link de checkout,
   textos de botão etc.) ou use a caixa "Detectar automaticamente":
   cole o código-fonte da nova LP e confirme os achados um por um.
5. Confira o painel de avisos no rodapé da página — precisa estar
   "Nenhum aviso" antes de exportar.
6. Clique em **"Baixar config.json"** — isso baixa o arquivo com **todos**
   os sites (o antigo + o novo), pronto pra substituir o do GitHub.

### Passo 3 — subir a versão nova pro GitHub

Sem precisar de terminal nem git instalado:

1. Acesse de novo `github.com/Matheusdearaujo95/Verificador-de-LP`
2. Clique no arquivo `config.json` na listagem.
3. Clique no ícone de lápis (✏️, "Edit this file") no canto superior direito.
4. Apague todo o conteúdo (Ctrl+A, Delete) e cole o conteúdo do
   `config.json` que você acabou de baixar (abra ele num editor de texto
   qualquer — Bloco de Notas, TextEdit — pra copiar).
5. Role até o final da página, escreva uma mensagem curta tipo
   "adiciona site X" na caixa de commit, e clique em **"Commit changes"**.

Pronto — na próxima execução de cada provedor (até 15 minutos), o site
novo já está sendo monitorado.

### Como confirmar que funcionou

- Se o `config.json` ficou com algum problema (campo faltando, JSON
  malformado), você recebe um alerta explícito de **"configuração
  inválida"** já na primeira execução seguinte — em qualquer canal
  configurado. Se isso acontecer, volte no `editor.html`, corrija o que o
  alerta apontar, e repita o Passo 3.
- Se não chegar nenhum alerta de configuração inválida em ~15-20 minutos,
  deu certo. Você também pode conferir direto: abra
  `github.com/Matheusdearaujo95/Verificador-de-LP/actions`, veja se a
  execução mais recente do "Vigia - monitoramento de LP" terminou com ✓
  verde (clique nela e depois em "Rodar o Vigia" pra ver o log completo,
  linha por linha, de cada checagem do site novo).

## Troubleshooting — problemas reais encontrados e como foram resolvidos

Fica registrado aqui porque, se algo parecido acontecer de novo (num
redeploy, numa VM nova), a causa provavelmente é a mesma.

- **`Deno.openKv is not a function`** — a plataforma nova do Deno Deploy
  não vem com KV habilitado por padrão; precisa provisionar e vincular
  explicitamente: `deno deploy database provision NOME --kind denokv --org ORG` seguido de `deno deploy database assign NOME --org ORG --app APP`.
- **Import de `config.json` fora da pasta do deploy quebra no Deno
  Deploy** (`Module not found "file:///tmp/build/config.json"`) — o CLI
  do Deno só sobe os arquivos de dentro da pasta indicada como fonte, ao
  contrário do Wrangler (Cloudflare), que empacota tudo antes de subir.
  Resolvido buscando o config ao vivo via `fetch()` em vez de `import`.
- **De onde buscar o `config.json` ao vivo mudou 3 vezes** até chegar
  numa fonte confiável — vale registrar a história completa porque cada
  tentativa falhou por um motivo diferente e não óbvio:
  1. `raw.githubusercontent.com` — demorou muito mais que os ~5 minutos
     documentados pra refletir um push durante os testes (cache de CDN).
  2. `api.github.com/repos/.../contents/...` — resolveu o cache, mas
     exige um header `User-Agent` em todo request (o `curl` manda um por
     padrão, por isso funcionava testando na mão, mas `fetch()` de
     Workers/Deno/Python não manda nada, e a API responde 403 sem esse
     header). Corrigido... e mesmo assim, **um dia depois em produção**,
     começou a devolver 403 direto — a API do GitHub sem autenticação só
     libera **60 requisições por hora por IP**, e o IP de saída de
     plataformas como Cloudflare Workers é compartilhado entre milhares de
     clientes ao redor do mundo, então essa cota se esgota rápido demais
     pra esse tipo de uso.
  3. **jsdelivr** (`cdn.jsdelivr.net/gh/usuario/repo@main/config.json`) —
     a solução final: é um CDN de verdade, feito especificamente pra
     servir arquivos de repositórios do GitHub, sem esse tipo de limite
     por IP. Usado hoje pelos 3 provedores que buscam o config ao vivo
     (Cloudflare Workers, Deno Deploy, Google Cloud Functions).
- **`gcloud functions deploy` falhando com "missing permission on the
  build service account"** — em projetos GCP novos, a conta de serviço
  padrão do Compute não vem com a permissão `roles/cloudbuild.builds.builder`
  necessária pra build da função. Resolvido concedendo esse papel
  explicitamente (está no `deploy-gcf.sh`).
- **E-mail e WhatsApp falhando silenciosamente só no Google Cloud** — o
  separador `;` usado pra driblar o parsing de vírgulas do próprio
  `gcloud` não era reconhecido pelo código (só aceitava `,`). Corrigido
  pra aceitar `,` e `;` em todo lugar.
- **Quad9 (`dns.quad9.net`) retornando HTTP 505** rodando no `wrangler dev`
  local (Miniflare) — confirmado com `curl` e `fetch()` puro do Node que o
  Quad9 funciona normalmente fora do simulador; é uma limitação só do
  ambiente de desenvolvimento local, não do código nem do Quad9 em si.
- **Uma falha real de rede transitória do próprio GitHub Actions**
  ("Network is unreachable" tentando alcançar o site) que se resolveu
  sozinha na execução seguinte — validou na prática a lógica de "só
  alertar na mudança de estado": não gerou pânico desnecessário, e a
  recuperação também disparou alerta normalmente.

## Limitações conhecidas (por design, não bugs)

- **SSL com validade em dias** só é checado nos provedores em Python
  (GitHub Actions, Google Cloud Functions) — Workers e Deno não expõem
  essa informação pra código de usuário, só confirmam que o HTTPS
  responde (o que já pega certificado vencido/inválido, só não avisa "vence
  em N dias" com antecedência).
- **7 resolvedores DNS** só nos provedores Python (DNS bruto via UDP).
  Workers e Deno usam 5 via DNS-over-HTTPS — Yandex e Level3/Lumen não têm
  endpoint DoH público confiável hoje.
- **Deno Deploy não manda e-mail**, sem exceção — bloqueio de plataforma
  contra spam, não é configurável.

## Sobre um 5º provedor (VM própria)

A Oracle Cloud (Always Free, região São Paulo) era a candidata natural —
daria um check HTTP de origem *realmente* brasileira, não só simulada via
DNS. O cadastro deu erro na criação da conta e não foi adiante. Se quiser
tentar de novo (ou usar outra VM, incluindo a e2-micro grátis do Compute
Engine dentro da conta Google Cloud que já existe aqui), o processo é:

1. Criar a VM, instalar Python 3.12 e `git`.
2. Clonar este repositório.
3. `pip install -r requirements.txt`.
4. Configurar as variáveis de ambiente (mesmos nomes da seção de secrets)
   num arquivo `.env` carregado pelo cron, ou exportadas no `crontab -e`.
   Adicione também `VIGIA_CONFIG_URL` (mesma URL da API do GitHub usada
   pelos outros provedores) se quiser que essa VM também pegue mudanças de
   config sem precisar puxar o repositório de novo — senão, um
   `git pull` antes de cada execução resolve.
5. Cron a cada 15 minutos:
   `*/15 * * * * cd /caminho/do/repo && VIGIA_PROVIDER_NAME="nome-da-vm" python3 monitor.py >> /var/log/vigia.log 2>&1`

## Segurança

Durante a configuração deste projeto, alguns valores sensíveis (token do
Telegram, senha de app do Gmail, apikeys do CallMeBot, um token do Deno
Deploy) foram colados em texto puro numa conversa de chat, e o próprio
`gcloud` também ecoou os valores de volta no terminal ao descrever o
deploy. Nenhum desses valores está neste repositório nem em nenhum
arquivo do projeto — mas como boa prática, vale revogar e gerar novos:

- **Telegram**: fale com o @BotFather e peça `/revoke` (ou `/token` pra pedir um novo).
- **Gmail**: revogue a senha de app antiga em `myaccount.google.com/apppasswords` e gere outra.
- **CallMeBot**: risco baixo (na pior hipótese, spam no seu próprio WhatsApp), mas pode reativar com uma apikey nova a qualquer momento mandando a mensagem de novo.
- **Deno Deploy**: gere um novo token em `console.deno.com` (Settings → Access Tokens) e revogue o antigo.
