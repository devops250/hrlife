#!/bin/bash
set -e

ENV="${1:-production}"
COMMIT="${2:-}"
PROD_DIR="/opt/hrlife-sdr"
STAGING_DIR="/opt/hrlife-sdr-staging"
DEPLOY_LOG="$PROD_DIR/deploy.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
  echo "[$TIMESTAMP] [ROLLBACK-$ENV] $1" | tee -a "$DEPLOY_LOG"
}

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

echo "=== Últimos 5 commits ==="
git log --oneline -5
echo ""

if [ -z "$COMMIT" ]; then
  echo "Uso: ./rollback.sh [production|staging] <commit_hash>"
  echo "Exemplo: ./rollback.sh production abc1234"
  exit 1
fi

log "=== Rollback iniciado ==="
log "Commit atual: $(git log --oneline -1)"
log "Rollback para: $COMMIT"

# Checkout do commit
git checkout "$COMMIT" -- .

# Rebuild
log "Rebuilding..."
npm install --production 2>&1 | tail -3
npm run build 2>&1

# Restart
log "Reiniciando PM2 ($PM2_NAME)..."
pm2 restart "$PM2_NAME" --update-env

# Health check
sleep 4
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HEALTH_PORT/health")

if [ "$HEALTH" = "200" ]; then
  log "Health check OK após rollback (HTTP $HEALTH)"
  log "Commit ativo: $(git log --oneline -1)"
  log "=== Rollback concluído com sucesso ==="
  echo ""
  echo "Rollback OK! Health: HTTP $HEALTH"
else
  log "ERRO: Health check falhou após rollback (HTTP $HEALTH)"
  echo "ERRO: Rollback falhou. Verificar logs: pm2 logs $PM2_NAME --lines 30"
  exit 1
fi
