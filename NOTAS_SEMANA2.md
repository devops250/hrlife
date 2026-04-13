# Notas — Semana 2A: Testes dos Fluxos Críticos

**Data:** 13/04/2026
**Objetivo:** Criar testes unitários para os 5 fluxos críticos da Helena antes das correções de bug.

---

## Checklist de Fluxos Testados

- [x] **Fluxo 1** — Mensagem Recebida (`message-flow.test.ts`) — 6 testes
  - 1.1 Webhook normaliza telefone e chama addToBuffer
  - 1.2 fromMe=true pausa o lead (addToBuffer não chamado)
  - 1.3 Número do Rodrigo (5512996217353) ignorado completamente
  - 1.4 Lead exhausted é reativado ao receber mensagem
  - 1.5 processBuffer agrega múltiplas msgs e chama processConversation 1x
  - 1.6 Comando #reset limpa histórico e envia confirmação

- [x] **Fluxo 2** — Follow-up (`followup-flow.test.ts`) — 4 testes + 1 todo
  - 2.1 Lead elegível recebe follow-up no estágio correto (followup_status=1 → stage 2)
  - 2.2 Lead com followup_status >= 4 não recebe mais follow-up
  - 2.3 enqueueForFollowup salva na fila Redis, getQueuedFollowups recupera e limpa
  - 2.4 TODO: reativação automática de lead pausado há 30+ min (requer exportar processFollowups)
  - 2.5 Delay mínimo entre estágios respeitado (15min < 120min = não envia)

- [x] **Fluxo 3** — Agendamento (`scheduling-flow.test.ts`) — 4 testes + 1 todo
  - 3.1 consulta_horario retorna slots disponíveis formatados em pt-BR
  - 3.2 registra_agendamento cria evento com Google Meet e marca lead.scheduled=true
  - 3.3 Slot ocupado retorna alternativas automaticamente (NÃO confirma agendamento)
  - 3.4 Sábado e domingo não têm slots na grade de horários
  - 3.5 TODO: endHour com horário 23:00 gera endDateTime=24:00:00 inválido (bug M12)

- [x] **Fluxo 4** — Coleta de Dados (`data-collection-flow.test.ts`) — 4 testes
  - 4.1 cadastra_lead salva todos os campos e chama syncLeadCreated
  - 4.2 Nome inválido (cliente/lead/usuário) é rejeitado, updateLeadData não chamado
  - 4.3 Dedup bloqueia chamada duplicada em menos de 30s
  - 4.4 cadastra_lead com agendado=true aciona syncLeadScheduled (não syncLeadCreated)

- [x] **Fluxo 5** — CRM Sync (`crm-sync-flow.test.ts`) — 6 testes
  - 5.1 syncLeadBasic: lead novo cria deal em Contato Feito
  - 5.2 syncLeadBasic: lead com rd_contact_id existente pula criação
  - 5.3 syncLeadCreated: contato existente com deal ativo não duplica deal
  - 5.4 syncLeadScheduled: move deal existente para estágio Agendado
  - 5.5 syncLeadScheduled: sem rd_deal_id executa fluxo completo de criação
  - 5.6 Campos customizados: fumante=Sim → ["Sim"], CPF limpo para só dígitos

---

## Resultado Final

| Métrica | Valor |
|---------|-------|
| Test Files | 8 passed (3 existentes + 5 novos) |
| Tests | 43 passed, 2 todo, 0 failed |
| Build (tsc --noEmit) | OK (EXIT:0) |
| Commits Semana 2A | 5 commits atômicos (1 por fluxo) |

---

## Bugs Reais Encontrados (testes marcados como .todo)

### TODO 2.4 — Reativação automática de lead pausado (scheduler)
- **Arquivo:** `src/followup/scheduler.ts`
- **Problema:** A função `processFollowups` não está exportada, impossibilitando teste direto.
- **Solução Semana 2B:** Exportar `processFollowups` ou extrair a lógica de reativação para função auxiliar exportada.

### TODO 3.5 — Bug M12: endHour overflow às 23h
- **Arquivo:** `src/conversation/tool-executor.ts` linha ~85
- **Código:** `const endHour = parseInt(horario.split(':')[0], 10) + 1;`
- **Bug:** Para horário `23:00`, gera `endDateTime = '..T24:00:00'` — inválido em ISO 8601.
- **Solução Semana 2B:** `const endHour = (parseInt(horario.split(':')[0], 10) + 1) % 24;`

---

## Observações Técnicas

- **Mock parcial de message-buffer:** usado `importOriginal` no Vitest para manter `processBuffer` real mas `addToBuffer` mockado. Permite testar a lógica de agregação de buffer sem timers.
- **recentCadastro Map (dedup):** estado persiste entre testes — cada teste de cadastra_lead usa phone exclusivo para evitar colisão.
- **vi.useFakeTimers + vi.runAllTimersAsync():** necessário para CRM sync (resolveContactId tem setTimeout 1s).
- **env.ts com process.exit(1):** carregado corretamente via .env do servidor durante os testes.

---

## Pendências para Semana 2B

1. **Exportar processFollowups** de scheduler.ts → desbloquear TODO 2.4
2. **Fix bug M12** (endHour overflow) → resolver TODO 3.5
3. **Bugs críticos de produção** (C1, C2, C3 do PLANO_CORRECOES_V2.md):
   - C1: freeBusy já implementado — validar cobertura de teste
   - C2: prompt anti-alucinação — adicionar teste de integração com engine mock
   - C3: mutex de deals duplicados — cobertura do mutex já em 5.4/5.5
4. **Ampliar cobertura de engine.ts** (God Object, ~400 linhas, 0% cobertura atual)


## Semana 2B — Resultado dos Fixes (13/04/2026)

### Fix 1: endHour overflow at 23h [M12] ✅
- **Arquivo:** src/conversation/tool-executor.ts
- **Mudança:** parseInt(horario)+1 → Date arithmetic (getTime()+3600000)
- **Teste 3.5:** ativado e passando (horario=23:00 gera endDateTime=2026-04-21T00:00:00)
- **Commit:** ebc66e1

### Fix 2: Engine timeout 30s → 60s [A3] ✅
- **Arquivo:** src/conversation/engine.ts linha 29
- **Mudança:** TIMEOUT_MS = 30000 → 60000
- **Commit:** 0576855

### Fix 3: reactivatePausedLeads exportada [TODO 2.4] ✅
- **Arquivo:** src/followup/scheduler.ts
- **Mudança:** lógica inline extraída para export async function reactivatePausedLeads()
- **Teste 2.4:** ativado — verifica reativação de lead pausado há 30+ min
- **Resultado:** 45 passed, 0 todo, 0 failed
- **Commit:** 10c1742

### Fix 4: Dedup Map → Redis [M2] ✅
- **Arquivo:** src/conversation/tool-executor.ts
- **Mudança:** recentCadastro Map → redisClient.set NX EX 30 (chave: dedup:cadastro:{phone}:{agendado})
- **Teste 4.3:** atualizado com mock Redis (SET NX retorna null na 2a chamada)
- **Commit:** f9dbf53

### Fix 5: Fila atômica MULTI/EXEC [A1] ✅
- **Arquivo:** src/followup/queue.ts
- **Mudança:** lRange + del separados → multi().lRange().del().exec() atômico
- **Teste 2.3:** atualizado com mock de multi/exec
- **Commit:** dc5d535

### Fix 6: Decompor crm/sync.ts [A4] ✅
- **Resultado:** 373 linhas → 231 linhas (−38%)
- **Novos arquivos:**
  - src/crm/sync-fields.ts (33 linhas): RD_CUSTOM_FIELDS + buildCustomFields
  - src/crm/sync-contact.ts (68 linhas): resolveContactId + safeUpdateContact + ensureDealScheduled
- **Commits:** d05cb13 (step 1) → a5c3642 (step 2+3) → 281e50d (final)
- **Testes:** 6/6 passando em crm-sync-flow após cada passo

### Resumo Final
| Métrica | Antes (Semana 2A) | Depois (Semana 2B) |
|---------|------------------|--------------------|
| Testes passando | 43 (2 todo) | 45 (0 todo) |
| sync.ts linhas | 373 | 231 |
| Dedup cadastro | Map (perde no restart) | Redis SET NX |
| Fila followup | 2 operações separadas | MULTI/EXEC atômico |
| Engine timeout | 30s | 60s |
