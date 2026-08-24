#!/usr/bin/env bash
# Script de referência pra publicar o Vigia no Google Cloud Functions +
# Cloud Scheduler. NÃO roda sozinho — é pra você ler e rodar os comandos
# manualmente (ou linha por linha) depois de ter uma conta GCP com
# faturamento ativado. Os detalhes de "onde clicar" ficam no README.
#
# Uso: preencha as variáveis abaixo e rode `bash deploy-gcf.sh`.

set -euo pipefail

PROJECT_ID="project-5066600a-9a75-4198-a04"  # projeto real já em uso
REGION="southamerica-east1"          # São Paulo
FUNCTION_NAME="vigia-acervodonutri"
BUCKET_NAME="${PROJECT_ID}-vigia-state"
SCHEDULER_JOB="vigia-a-cada-15min"
SCHEDULER_SA="vigia-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"

# 0) Ativar as APIs necessárias (roda só uma vez por projeto).
gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com run.googleapis.com storage.googleapis.com \
  artifactregistry.googleapis.com iam.googleapis.com

# 1) Bucket pra guardar o state.json (roda só uma vez).
gsutil mb -l "$REGION" "gs://${BUCKET_NAME}" || echo "Bucket já existe, ok."

# 2) Conta de serviço que o Cloud Scheduler vai usar pra chamar a função.
gcloud iam service-accounts create vigia-scheduler \
  --display-name="Vigia - Cloud Scheduler" || echo "Já existe, ok."

# 2.1) Em projetos novos, a conta de serviço padrão do Compute (usada pelo
# Cloud Build pra construir a função) não vem com permissão suficiente por
# padrão — sem isso o deploy falha com "missing permission on the build
# service account". Descoberto na prática, não está na documentação óbvia.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"

# 2.2) Essa mesma conta (é quem roda a função em si) precisa poder ler e
# gravar o bucket do estado.
gsutil iam ch \
  "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com:roles/storage.objectAdmin" \
  "gs://${BUCKET_NAME}"

# 3) Publicar a função (Gen2). Os secrets (Telegram, SMTP, CallMeBot) são
# passados como variáveis de ambiente — troque pelos valores reais ou,
# melhor ainda, use --set-secrets com o Secret Manager.
gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=python312 \
  --region="$REGION" \
  --source=. \
  --entry-point=vigia_http \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=256Mi \
  --timeout=120s \
  --set-env-vars="VIGIA_PROVIDER_NAME=Google Cloud Functions,VIGIA_STATE_BACKEND=gcs,VIGIA_GCS_BUCKET=${BUCKET_NAME}"

# 3.1) Secrets, num comando separado (--update-env-vars, pra não apagar as
# variáveis de cima). Importante: o --set-env-vars/--update-env-vars do
# gcloud já usa vírgula pra separar variáveis entre si, então dentro do
# valor de ALERT_EMAIL_TO e CALLMEBOT_RECIPIENTS (que também aceitam
# vírgula) use ";" em vez de "," — o monitor.py entende os dois.
gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --region="$REGION" \
  --update-env-vars="TELEGRAM_BOT_TOKEN=SUBSTITUA,TELEGRAM_CHAT_ID=SUBSTITUA,SMTP_HOST=smtp.gmail.com,SMTP_PORT=587,SMTP_USER=SUBSTITUA,SMTP_PASS=SUBSTITUA,ALERT_EMAIL_TO=email1@x.com;email2@x.com,CALLMEBOT_RECIPIENTS=+5511999999999:SUBSTITUA;+5511888888888:SUBSTITUA"

# 4) Dar permissão pra essa conta de serviço invocar a função.
gcloud functions add-invoker-policy-binding "$FUNCTION_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}"

FUNCTION_URL=$(gcloud functions describe "$FUNCTION_NAME" --region="$REGION" --gen2 --format="value(serviceConfig.uri)")

# 5) Cloud Scheduler chamando a função a cada 15 minutos.
gcloud scheduler jobs create http "$SCHEDULER_JOB" \
  --location="$REGION" \
  --schedule="*/15 * * * *" \
  --uri="$FUNCTION_URL" \
  --http-method=GET \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="$FUNCTION_URL"

echo "Pronto. Pra testar na mão: gcloud scheduler jobs run $SCHEDULER_JOB --location=$REGION"
