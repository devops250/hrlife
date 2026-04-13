# Notas — Semana 1 de Estabilização

## Data: 13/04/2026

## Tarefas executadas:

- [x] T1: Remover credenciais hardcoded (validate-rd.mjs, test-e2e.ts)
- [x] T2: Blindar .gitignore
- [x] T3: Autenticação no dashboard + fix SQL injection
- [x] T4: Extrair redisClient para config/redis.ts (quebrar dependência circular)
- [x] T5: Centralizar env vars (audio.service, meta-leads.handler)
- [x] T6: Remover dead code (isBusinessHours, generateFollowUpShort, isValidSlot, convertBirthdayToISO)
- [x] T7: Validação final

## Problemas fora do escopo (para Semana 2):

- `@types/express` está em dependencies em vez de devDependencies
- `getSaoPauloNow()` usa toLocaleString que pode ter imprecisão de fuso
- `debounceTimers` em memória (message-buffer.ts) — não sobrevive restart
- `recentCadastro` em memória (tool-executor.ts) — idem
- Cobertura de testes ~5% — precisa de testes para engine, pipeline, sync
- Dashboard HTML sem autenticação client-side (apenas API protegida)
- `_getPeriodFilter_OLD` ficou no dashboard.ts (dead code do refactor)

## Remediação (13/04/2026)

- [x] Item 1: stages.test.ts corrigido com async/await
- [x] Item 2: _getPeriodFilter_OLD removido de dashboard.ts
- [x] Item 3: DATABASE_URL fallback removido de test-e2e.ts
- [x] Item 4: variável phone dead code removida de meta-leads.handler.ts (M10 confirmado como dead code)
- [x] Item 5: validação final
