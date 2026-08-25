#!/usr/bin/env python3
"""
Vigia — monitor de disponibilidade de LPs.

Roda de forma independente em qualquer provedor que execute Python
(GitHub Actions, Google Cloud Functions, VM na Oracle Cloud, ou local).
Sem servidor central, sem banco de dados: cada execução lê config.json,
compara com o estado da última execução (state.json) e só alerta quando
algo MUDA de estado (ok -> falha, ou falha -> ok).
"""

from __future__ import annotations

import json
import os
import re
import smtplib
import socket
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.mime.text import MIMEText

import dns.edns
import dns.resolver
import requests

# ---------------------------------------------------------------------------
# Configuração fixa do script (não depende do config.json)
# ---------------------------------------------------------------------------

CONFIG_PATH = os.environ.get("VIGIA_CONFIG", os.path.join(os.path.dirname(__file__), "config.json"))
# Se definido, o config.json é buscado ao vivo dessa URL a cada execução em
# vez do arquivo local — assim como Cloudflare Workers e Deno Deploy,
# editar o config.json (pelo editor.html) e subir pro GitHub já vale sem
# precisar reimplantar a função. GitHub Actions e a VM continuam lendo o
# arquivo local (já é sempre a versão atual do repositório).
CONFIG_URL = os.environ.get("VIGIA_CONFIG_URL")
STATE_PATH = os.environ.get("VIGIA_STATE", os.path.join(os.path.dirname(__file__), "state.json"))
PROVIDER_NAME = os.environ.get("VIGIA_PROVIDER_NAME", "desconhecido")

# Chave da API do Google (Safe Browsing + PageSpeed Insights). Se não for
# definida, as duas checagens simplesmente não rodam (não é erro).
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")

# "file" (padrão, usado por GitHub Actions e pela VM na Oracle) ou "gcs"
# (usado pelo Google Cloud Functions, que não tem disco persistente entre
# execuções — o estado nativo da plataforma ali é um objeto no Cloud
# Storage).
STATE_BACKEND = os.environ.get("VIGIA_STATE_BACKEND", "file")
GCS_BUCKET = os.environ.get("VIGIA_GCS_BUCKET")
GCS_BLOB = os.environ.get("VIGIA_GCS_BLOB", "state.json")

REQUEST_TIMEOUT = 15

DEFAULT_DNS_RESOLVERS = {
    "Google": "8.8.8.8",
    "Cloudflare": "1.1.1.1",
    "Quad9": "9.9.9.9",
    "OpenDNS": "208.67.222.222",
    "AdGuard": "94.140.14.14",
    "Level3": "4.2.2.2",
    "Yandex": "77.88.8.8",
}

# Blocos de IP usados só para simular a origem da consulta via EDNS Client
# Subnet (não são resolvedores, são "de onde a pergunta parece vir"). São
# blocos conhecidos e estáveis o suficiente para geolocalizar de forma
# consistente; podem ser sobrescritos no config.json em "ecs_regions".
DEFAULT_ECS_REGIONS = {
    "São Paulo": "200.221.0.0/24",
    "Rio de Janeiro": "200.223.0.0/24",
    "Nordeste": "200.199.0.0/24",
    "EUA": "8.8.8.0/24",
    "Europa": "185.60.216.0/24",
}

TRACKING_PARAM_PREFIXES = ("utm_",)
TRACKING_PARAMS_EXACT = {"sck", "fbclid", "gclid", "ttclid"}

DEVICE_USER_AGENTS = {
    "mobile": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    ),
    "desktop": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
}

BAD_TEXT_CHARS = re.compile(
    "[←-⇿⌀-➿\U0001F000-\U0001FAFF⬀-⯿]"
)  # setas, símbolos diversos, emoji


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

class CheckResult:
    def __init__(self, ok: bool, detail: str):
        self.ok = ok
        self.detail = detail


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_state() -> dict:
    if STATE_BACKEND == "gcs":
        from google.cloud import storage  # import tardio: só precisa existir no GCF

        bucket = storage.Client().bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_BLOB)
        if not blob.exists():
            return {}
        return json.loads(blob.download_as_text())

    return load_json(STATE_PATH) if os.path.exists(STATE_PATH) else {}


def save_state(state: dict) -> None:
    if STATE_BACKEND == "gcs":
        from google.cloud import storage

        bucket = storage.Client().bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_BLOB)
        blob.upload_from_string(json.dumps(state, ensure_ascii=False, indent=2), content_type="application/json")
        return

    save_json(STATE_PATH, state)


# ---------------------------------------------------------------------------
# Validação do config.json
# ---------------------------------------------------------------------------

REQUIRED_SITE_FIELDS = ["name", "domain", "expected_ip", "checkout_url", "content_checks"]
REQUIRED_CONTENT_CHECK_FIELDS = ["device", "url", "expected_texts"]


def validate_config(config: dict) -> list[str]:
    """Retorna lista de problemas encontrados (vazia = config válido)."""
    problems: list[str] = []

    if not isinstance(config, dict) or "sites" not in config:
        return ["config.json não tem a chave 'sites'."]

    sites = config.get("sites")
    if not isinstance(sites, list) or not sites:
        return ["'sites' precisa ser uma lista com pelo menos um site."]

    for i, site in enumerate(sites):
        label = f"site #{i + 1}"
        if not isinstance(site, dict):
            problems.append(f"{label}: não é um objeto válido.")
            continue

        label = f"site '{site.get('name', label)}'"

        for field in REQUIRED_SITE_FIELDS:
            if not site.get(field):
                problems.append(f"{label}: campo obrigatório '{field}' está vazio ou ausente.")

        content_checks = site.get("content_checks", [])
        if not isinstance(content_checks, list) or not content_checks:
            problems.append(f"{label}: precisa de ao menos um item em 'content_checks'.")
        else:
            devices_seen = set()
            for j, check in enumerate(content_checks):
                clabel = f"{label}, content_checks #{j + 1}"
                if not isinstance(check, dict):
                    problems.append(f"{clabel}: não é um objeto válido.")
                    continue
                for field in REQUIRED_CONTENT_CHECK_FIELDS:
                    if not check.get(field):
                        problems.append(f"{clabel}: campo obrigatório '{field}' ausente.")
                device = check.get("device")
                if device and device not in DEVICE_USER_AGENTS:
                    problems.append(
                        f"{clabel}: device '{device}' desconhecido "
                        f"(use 'mobile' ou 'desktop')."
                    )
                devices_seen.add(device)

                expected_texts = check.get("expected_texts", [])
                for text in expected_texts:
                    if BAD_TEXT_CHARS.search(text):
                        problems.append(
                            f"{clabel}: texto esperado '{text}' contém seta/ícone/emoji "
                            f"e provavelmente nunca vai bater com o HTML."
                        )

            if devices_seen == {"mobile"} or devices_seen == {"desktop"}:
                problems.append(
                    f"{label}: todos os content_checks são do mesmo dispositivo "
                    f"({devices_seen.pop()}) — a outra versão fica sem vigilância."
                )

    return problems


# ---------------------------------------------------------------------------
# Checagens
# ---------------------------------------------------------------------------

def check_dns_resolvers(domain: str, expected_ip: str, resolvers: dict) -> CheckResult:
    results = {}
    errors = []
    for name, ip in resolvers.items():
        try:
            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = [ip]
            resolver.timeout = 5
            resolver.lifetime = 5
            answer = resolver.resolve(domain, "A")
            ips = sorted(r.to_text() for r in answer)
            results[name] = ips
        except Exception as exc:  # noqa: BLE001 - qualquer falha de DNS vira "detalhe"
            errors.append(f"{name}: {exc}")

    if errors and not results:
        return CheckResult(False, "todos os resolvedores falharam: " + "; ".join(errors))

    distinct_answers = {tuple(ips) for ips in results.values()}
    problems = []
    if len(distinct_answers) > 1:
        problems.append(f"resolvedores divergem entre si: {results}")
    for name, ips in results.items():
        if expected_ip not in ips:
            problems.append(f"{name} respondeu {ips}, esperado {expected_ip}")
    if errors:
        problems.append("falharam: " + "; ".join(errors))

    if problems:
        return CheckResult(False, " | ".join(problems))
    return CheckResult(True, f"todos os {len(results)} resolvedores concordam em {expected_ip}")


def check_dns_region(domain: str, expected_ip: str, regions: dict) -> CheckResult:
    problems = []
    ok_regions = []
    for region_name, subnet in regions.items():
        try:
            params = urllib.parse.urlencode(
                {"name": domain, "type": "A", "edns_client_subnet": subnet}
            )
            url = f"https://dns.google/resolve?{params}"
            with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            answers = [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]
            if expected_ip in answers:
                ok_regions.append(region_name)
            else:
                problems.append(f"{region_name} ({subnet}) recebeu {answers or 'nenhuma resposta A'}")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{region_name} ({subnet}): erro ao consultar — {exc}")

    if problems:
        return CheckResult(False, " | ".join(problems))
    return CheckResult(True, f"IP esperado confirmado em: {', '.join(ok_regions)}")


def check_ssl_certificate(domain: str, alert_days: int) -> CheckResult:
    try:
        context = ssl.create_default_context()
        with socket.create_connection((domain, 443), timeout=REQUEST_TIMEOUT) as sock:
            with context.wrap_socket(sock, server_hostname=domain) as ssock:
                cert = ssock.getpeercert()
        not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(
            tzinfo=timezone.utc
        )
        days_left = (not_after - datetime.now(timezone.utc)).days
        if days_left < 0:
            return CheckResult(False, f"certificado VENCIDO desde {not_after.date()}")
        if days_left <= alert_days:
            return CheckResult(False, f"certificado vence em {days_left} dias ({not_after.date()})")
        return CheckResult(True, f"certificado válido até {not_after.date()} ({days_left} dias)")
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao verificar certificado: {exc}")


def normalize_whitespace(text: str) -> str:
    """Trata espaço normal, &nbsp; e \\xa0 como equivalentes na comparação."""
    return text.replace("&nbsp;", " ").replace("\xa0", " ")


def check_content(url: str, device: str, expected_texts: list[str]) -> CheckResult:
    headers = {"User-Agent": DEVICE_USER_AGENTS.get(device, DEVICE_USER_AGENTS["desktop"])}
    try:
        resp = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao acessar {url}: {exc}")

    if resp.status_code >= 400:
        return CheckResult(False, f"{url} respondeu HTTP {resp.status_code}")

    haystack = normalize_whitespace(resp.text)
    missing = [text for text in expected_texts if normalize_whitespace(text) not in haystack]
    if missing:
        return CheckResult(False, f"textos ausentes no HTML ({device}): {missing}")
    return CheckResult(True, f"todos os {len(expected_texts)} textos encontrados ({device})")


def check_url_is_up(url: str, label: str) -> CheckResult:
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if resp.status_code >= 400:
            return CheckResult(False, f"{label} respondeu HTTP {resp.status_code}")
        return CheckResult(True, f"{label} no ar (HTTP {resp.status_code})")
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao acessar {label}: {exc}")


def check_instagram_bio(url: str, expected_domain: str) -> CheckResult:
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao acessar link da bio: {exc}")

    final_domain = urllib.parse.urlparse(resp.url).netloc
    if expected_domain not in final_domain:
        return CheckResult(
            False, f"link da bio terminou em '{final_domain}', esperado '{expected_domain}'"
        )
    if resp.status_code >= 400:
        return CheckResult(False, f"link da bio respondeu HTTP {resp.status_code}")
    return CheckResult(True, f"link da bio termina em {final_domain}")


def check_ad_link_utms(url: str) -> CheckResult:
    original_params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    expected_utms = {k: v[0] for k, v in original_params.items() if k.startswith("utm_")}

    if not expected_utms:
        return CheckResult(False, "URL de anúncio não tem nenhum parâmetro utm_* para checar")

    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao seguir redirecionamento: {exc}")

    final_params = urllib.parse.parse_qs(urllib.parse.urlparse(resp.url).query)
    lost = []
    changed = []
    for key, value in expected_utms.items():
        final_values = final_params.get(key)
        if not final_values:
            lost.append(key)
        elif final_values[0] != value:
            changed.append(f"{key}: '{value}' -> '{final_values[0]}'")

    if lost or changed:
        problems = []
        if lost:
            problems.append(f"parâmetros perdidos no redirect: {lost}")
        if changed:
            problems.append(f"parâmetros alterados: {changed}")
        return CheckResult(False, " | ".join(problems))
    return CheckResult(True, f"todos os {len(expected_utms)} UTMs sobreviveram até {resp.url}")


SAFE_BROWSING_THREAT_TYPES = [
    "MALWARE",
    "SOCIAL_ENGINEERING",
    "UNWANTED_SOFTWARE",
    "POTENTIALLY_HARMFUL_APPLICATION",
]


def check_safe_browsing(urls: list[str]) -> CheckResult:
    body = {
        "client": {"clientId": "vigia-monitor", "clientVersion": "1.0"},
        "threatInfo": {
            "threatTypes": SAFE_BROWSING_THREAT_TYPES,
            "platformTypes": ["ANY_PLATFORM"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{"url": u} for u in urls],
        },
    }
    try:
        resp = requests.post(
            f"https://safebrowsing.googleapis.com/v4/threatMatches:find?key={GOOGLE_API_KEY}",
            json=body,
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao consultar o Google Safe Browsing: {exc}")

    matches = data.get("matches", [])
    if matches:
        found = sorted({m.get("threat", {}).get("url", "?") + " (" + m.get("threatType", "?") + ")" for m in matches})
        return CheckResult(False, f"Google Safe Browsing encontrou problema: {', '.join(found)}")
    return CheckResult(True, f"nenhuma URL marcada como phishing/malware pelo Google Safe Browsing ({len(urls)} verificadas)")


def check_pagespeed(url: str, alert_below: float) -> CheckResult:
    try:
        resp = requests.get(
            "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
            params={"url": url, "key": GOOGLE_API_KEY, "strategy": "mobile", "category": "performance"},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        score = data["lighthouseResult"]["categories"]["performance"]["score"]
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"erro ao consultar o PageSpeed Insights: {exc}")

    score_pct = round(score * 100)
    if score < alert_below:
        return CheckResult(False, f"nota de performance (mobile) caiu pra {score_pct}/100, abaixo do limite de {round(alert_below * 100)}")
    return CheckResult(True, f"nota de performance (mobile): {score_pct}/100")


def strip_tracking_params(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    kept = [
        (k, v)
        for k, v in params
        if not k.startswith(TRACKING_PARAM_PREFIXES) and k not in TRACKING_PARAMS_EXACT
    ]
    new_query = urllib.parse.urlencode(kept)
    return urllib.parse.urlunparse(parsed._replace(query=new_query))


# ---------------------------------------------------------------------------
# Alertas
# ---------------------------------------------------------------------------

def send_telegram(message: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("[alerta] Telegram não configurado (faltam TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        requests.post(url, data={"chat_id": chat_id, "text": message}, timeout=REQUEST_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"[alerta] falha ao enviar Telegram: {exc}")


def send_email(subject: str, message: str) -> None:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    to_raw = os.environ.get("ALERT_EMAIL_TO", user)
    # aceita "," ou ";" como separador — alguns provedores (Google Cloud)
    # usam vírgula pra separar as próprias variáveis de ambiente, então
    # documentamos ";" como alternativa nesses casos.
    to_addrs = [addr.strip() for addr in re.split(r"[,;]", to_raw or "") if addr.strip()]
    if not all([host, user, password]) or not to_addrs:
        print("[alerta] e-mail não configurado (faltam variáveis SMTP_*)")
        return
    msg = MIMEText(message, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = ", ".join(to_addrs)
    try:
        with smtplib.SMTP(host, port, timeout=REQUEST_TIMEOUT) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(user, to_addrs, msg.as_string())
    except Exception as exc:  # noqa: BLE001
        print(f"[alerta] falha ao enviar e-mail: {exc}")


def _callmebot_recipients() -> list[tuple[str, str]]:
    # CALLMEBOT_RECIPIENTS="5511999999999:123456,5511888888888:654321" — um
    # par por número, porque a apikey do CallMeBot é vinculada ao número que
    # ativou. Mantém CALLMEBOT_PHONE/CALLMEBOT_APIKEY funcionando sozinhos
    # pra quem só tem um número.
    multi = os.environ.get("CALLMEBOT_RECIPIENTS", "")
    pairs = []
    for entry in re.split(r"[,;]", multi):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            continue
        phone, apikey = entry.split(":", 1)
        if phone.strip() and apikey.strip():
            pairs.append((phone.strip(), apikey.strip()))
    if pairs:
        return pairs

    phone = os.environ.get("CALLMEBOT_PHONE")
    apikey = os.environ.get("CALLMEBOT_APIKEY")
    if phone and apikey:
        return [(phone, apikey)]
    return []


def send_whatsapp_callmebot(message: str) -> None:
    recipients = _callmebot_recipients()
    if not recipients:
        print("[alerta] CallMeBot não configurado (faltam CALLMEBOT_PHONE/CALLMEBOT_APIKEY ou CALLMEBOT_RECIPIENTS) — ok, é bônus")
        return
    for phone, apikey in recipients:
        try:
            params = urllib.parse.urlencode({"phone": phone, "text": message, "apikey": apikey})
            requests.get(f"https://api.callmebot.com/whatsapp.php?{params}", timeout=REQUEST_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            print(f"[alerta] falha ao enviar WhatsApp via CallMeBot pra {phone} (esperado, não é confiável): {exc}")


def send_alert(subject: str, message: str) -> None:
    full_message = f"[Vigia | {PROVIDER_NAME}] {subject}\n\n{message}"
    print(full_message)
    send_telegram(full_message)
    send_email(f"[Vigia] {subject}", full_message)
    send_whatsapp_callmebot(full_message)


# ---------------------------------------------------------------------------
# Execução principal
# ---------------------------------------------------------------------------

def build_site_checks(site: dict) -> dict:
    """Roda todas as checagens de um site e retorna {chave_do_check: CheckResult}."""
    results: dict[str, CheckResult] = {}

    resolvers = site.get("dns_resolvers", DEFAULT_DNS_RESOLVERS)
    results["dns_resolvers"] = check_dns_resolvers(site["domain"], site["expected_ip"], resolvers)

    regions = site.get("ecs_regions", DEFAULT_ECS_REGIONS)
    results["dns_region"] = check_dns_region(site["domain"], site["expected_ip"], regions)

    ssl_alert_days = site.get("ssl_alert_days", 20)
    results["ssl"] = check_ssl_certificate(site["domain"], ssl_alert_days)

    for check in site["content_checks"]:
        key = f"content_{check['device']}"
        results[key] = check_content(check["url"], check["device"], check["expected_texts"])

    results["checkout"] = check_url_is_up(site["checkout_url"], "checkout")

    if site.get("instagram_bio_url"):
        results["instagram_bio"] = check_instagram_bio(
            site["instagram_bio_url"], site.get("instagram_bio_expected_domain", site["domain"])
        )

    for i, ad_link in enumerate(site.get("ad_links", [])):
        key = f"ad_link_{i}_{ad_link.get('name', 'sem_nome')}"
        results[key] = check_ad_link_utms(ad_link["url"])

    if GOOGLE_API_KEY:
        home_url = f"https://{site['domain']}/"
        urls_to_check = sorted({home_url, site["checkout_url"]})
        results["safe_browsing"] = check_safe_browsing(urls_to_check)

        pagespeed_alert_below = site.get("pagespeed_alert_below", 0.5)
        results["pagespeed"] = check_pagespeed(home_url, pagespeed_alert_below)

    return results


def run() -> int:
    if CONFIG_URL:
        try:
            resp = requests.get(CONFIG_URL, headers={"user-agent": "vigia-monitor"}, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            config = resp.json()
        except Exception as exc:  # noqa: BLE001
            send_alert(
                "configuração inválida",
                f"Não consegui buscar o config.json em '{CONFIG_URL}': {exc}. Nenhuma checagem foi feita.",
            )
            return 1
    else:
        if not os.path.exists(CONFIG_PATH):
            send_alert(
                "configuração inválida",
                f"Arquivo de config não encontrado em '{CONFIG_PATH}'. Nenhuma checagem foi feita.",
            )
            return 1

        try:
            config = load_json(CONFIG_PATH)
        except Exception as exc:  # noqa: BLE001
            send_alert(
                "configuração inválida",
                f"config.json malformado (JSON inválido): {exc}. Nenhuma checagem foi feita.",
            )
            return 1

    problems = validate_config(config)
    if problems:
        send_alert(
            "configuração inválida",
            "config.json tem problemas e nenhuma checagem foi feita:\n- " + "\n- ".join(problems),
        )
        return 1

    if STATE_BACKEND == "gcs" and not GCS_BUCKET:
        send_alert(
            "configuração inválida",
            "VIGIA_STATE_BACKEND=gcs mas VIGIA_GCS_BUCKET não foi definido. Nenhuma checagem foi feita.",
        )
        return 1

    state = load_state()
    had_transition = False

    for site in config["sites"]:
        site_key = site["domain"]
        site_state = state.setdefault(site_key, {})
        results = build_site_checks(site)

        for check_key, result in results.items():
            previous = site_state.get(check_key)
            previous_ok = previous.get("ok") if previous else None

            if previous_ok is None or previous_ok != result.ok:
                had_transition = True
                status_word = "OK" if result.ok else "FALHA"
                send_alert(
                    f"{site['name']} — {check_key}: {status_word}",
                    result.detail,
                )

            site_state[check_key] = {
                "ok": result.ok,
                "detail": result.detail,
                "checked_at": now_iso(),
            }

    save_state(state)
    print(f"Checagem concluída em {now_iso()} (provedor: {PROVIDER_NAME}). Mudanças de estado: {had_transition}")
    return 0


if __name__ == "__main__":
    sys.exit(run())
