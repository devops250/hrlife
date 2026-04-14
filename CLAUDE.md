

## Deploy em produção
O PM2 roda build automaticamente se src/ for mais recente que dist/.
Para restart manual: `pm2 restart hrlife-sdr`
Para deploy após mudanças: `pm2 restart hrlife-sdr` (build roda automaticamente)
NUNCA rodar `node dist/index.js` diretamente — sempre via PM2.
