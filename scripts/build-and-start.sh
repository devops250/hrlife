#!/bin/bash
set -e
cd /opt/hrlife-sdr
echo "[DEPLOY] Verificando se build é necessário..."

NEWEST_SRC=$(find src/ -name "*.ts" -not -path "*__tests__*" -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
DIST_TIME=$(stat -c '%Y' dist/index.js 2>/dev/null || echo "0")

if [ "$(echo "$NEWEST_SRC > $DIST_TIME" | bc)" -eq 1 ]; then
  echo "[DEPLOY] src/ mais recente que dist/ — rodando build..."
  npm run build
  echo "[DEPLOY] Build concluído"
else
  echo "[DEPLOY] dist/ atualizado — pulando build"
fi

echo "[DEPLOY] Iniciando processo..."
exec node --max-old-space-size=256 dist/index.js
