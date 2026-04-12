#!/bin/bash
set -e

ENV="${1:-staging}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PROD_DIR="/opt/hrlife-sdr"
STAGING_DIR="/opt/hrlife-sdr-staging"
DEPLOY_LOG="$PROD_DIR/deploy.log"

log() {
  echo "[$TIMESTAMP] [$ENV] $1" | tee -a "$DEPLOY_LOG"
}

if [ "$ENV" != "staging" ] && [ "$ENV" != "production" ]; then
  echo "Uso: ./deploy.sh [staging|production]"
  exit 1
fi

if [ "$ENV" = "staging" ]; then
  DIR="$STAGING_DIR"
  PM2_NAME="hrlife-sdr-staging"
  HEALTH_PORT=3101
else
  DIR="$PROD_DIR"
  PM2_NAME="hrlife-sdr"
  HEALTH_PORT=3100
fi

cd "$DIR"

log "=== Deploy iniciado ==="
log "Diretório: $DIR"
log "Commit atual: $(git log --oneline -1 2>/dev/null || echo 'sem git')"

# Salvar commit atual para rollback
PREVIOUS_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")

# Pull
if git remote -v 2>/dev/null | grep -q origin; then
  log "git pull..."
  git pull origin main 2>&1 | tee -a "$DEPLOY_LOG"
fi

# Install
log "npm install..."
npm install --production 2>&1 | tail -3 | tee -a "$DEPLOY_LOG"

# Build
log "Building TypeScript..."
npm run build 2>&1 | tee -a "$DEPLOY_LOG"
if [ $? -ne 0 ]; then
  log "ERRO: Build falhou!"
  if [ -n "$PREVIOUS_COMMIT" ] && [ "$ENV" = "production" ]; then
    log "Rollback para $PREVIOUS_COMMIT..."
    git checkout "$PREVIOUS_COMMIT" -- .
    npm run build 2>&1 | tee -a "$DEPLOY_LOG"
    pm2 restart "$PM2_NAME" --update-env
    log "Rollback concluído"
  fi
  exit 1
fi

# Restart PM2
log "Reiniciando PM2 ($PM2_NAME)..."
pm2 restart "$PM2_NAME" --update-env 2>&1 | tee -a "$DEPLOY_LOG"

# Smoke test
sleep 4
log "Smoke test..."
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HEALTH_PORT/health")

if [ "$HEALTH" = "200" ]; then
  log "Health check OK (HTTP $HEALTH)"
  log "Novo commit: $(git log --oneline -1)"
  log "=== Deploy concluído com sucesso ==="
else
  log "ERRO: Health check falhou (HTTP $HEALTH)"
  if [ -n "$PREVIOUS_COMMIT" ] && [ "$ENV" = "production" ]; then
    log "Rollback automático para $PREVIOUS_COMMIT..."
    git checkout "$PREVIOUS_COMMIT" -- .
    npm run build 2>&1 | tee -a "$DEPLOY_LOG"
    pm2 restart "$PM2_NAME" --update-env
    sleep 3
    ROLLBACK_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HEALTH_PORT/health")
    log "Rollback health: HTTP $ROLLBACK_HEALTH"
    log "=== Rollback concluído ==="
  fi
  exit 1
fi
