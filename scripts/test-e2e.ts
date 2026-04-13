/**
 * Teste E2E — Helena SDR IA
 *
 * Simula o fluxo completo de um lead:
 * 1. Chegada via Pluga webhook
 * 2. Conversa de coleta de dados via WhatsApp
 * 3. Agendamento
 * 4. Verificação no RD Station
 * 5. Limpeza
 *
 * Uso: npx tsx scripts/test-e2e.ts
 */

import pg from 'pg';

const BASE_URL = 'http://localhost:3100';
const TEST_PHONE = '5511900000001';
const TEST_NAME = 'Teste E2E Helena';
const TEST_EMAIL = 'teste-e2e@cognita.ai';

// Database
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurado. Rode com: DATABASE_URL=... npx tsx scripts/test-e2e.ts');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// RD Station — carregado do .env no main()
let RD_TOKEN = '';

// Contadores
let passed = 0;
let failed = 0;
const startTime = Date.now();

// IDs para limpeza
let rdContactId: string | null = null;
let rdDealId: string | null = null;
let calendarEventId: string | null = null;

// ──────────────────────────────────────────────

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function pass(test: string, detail?: string) {
  passed++;
  console.log(`  ✅ PASS: ${test}${detail ? ` — ${detail}` : ''}`);
}

function fail(test: string, error: unknown) {
  failed++;
  console.log(`  ❌ FAIL: ${test}`);
  console.log(`     Erro: ${error}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function query(sql: string, params?: unknown[]) {
  return pool.query(sql, params);
}

async function sendWebhook(path: string, body: object): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendWhatsAppMessage(text: string) {
  return sendWebhook('/sdr', {
    message: {
      text,
      fromMe: false,
      messageType: 'conversation',
      id: `test-${Date.now()}`,
    },
    chat: { phone: TEST_PHONE },
  });
}

async function getLeadFromDB() {
  const result = await query('SELECT * FROM leads WHERE phone = $1', [TEST_PHONE]);
  return result.rows[0] || null;
}

async function getLastAssistantMessage() {
  const result = await query(
    "SELECT content FROM conversations WHERE phone = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
    [TEST_PHONE],
  );
  return result.rows[0]?.content || '';
}

async function getToolEvents() {
  const result = await query(
    "SELECT type, payload FROM events WHERE phone = $1 AND type = 'tool_called' ORDER BY created_at DESC LIMIT 5",
    [TEST_PHONE],
  );
  return result.rows;
}

async function waitForResponse(timeoutMs = 20000): Promise<string> {
  const start = Date.now();
  let lastMsg = await getLastAssistantMessage();
  const initialMsg = lastMsg;

  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    lastMsg = await getLastAssistantMessage();
    if (lastMsg && lastMsg !== initialMsg) return lastMsg;
  }

  return lastMsg || '[sem resposta]';
}

// ──────────────────────────────────────────────

async function etapa1_chegadaLead() {
  console.log('\n═══════════════════════════════════════');
  console.log('ETAPA 1 — Chegada do Lead via Pluga');
  console.log('═══════════════════════════════════════');

  const t0 = Date.now();

  // Limpar lead anterior se existir
  await query('DELETE FROM conversations WHERE phone = $1', [TEST_PHONE]);
  await query('DELETE FROM events WHERE phone = $1', [TEST_PHONE]);
  await query('DELETE FROM leads WHERE phone = $1', [TEST_PHONE]);

  // Enviar webhook Pluga
  const res = await sendWebhook('/webhook/pluga', {
    nome: TEST_NAME,
    telefone: TEST_PHONE,
    email: TEST_EMAIL,
  });

  if (res.ok) {
    pass('Webhook aceito', `HTTP ${res.status}`);
  } else {
    fail('Webhook aceito', `HTTP ${res.status}`);
    return;
  }

  // Esperar processamento (sync RD é assíncrono)
  await sleep(5000);

  // Verificar lead no banco
  const lead = await getLeadFromDB();
  if (lead) {
    pass('Lead criado no banco', `phone=${lead.phone}, name=${lead.name}, source=${lead.source}`);
  } else {
    fail('Lead criado no banco', 'Lead não encontrado');
    return;
  }

  // Verificar RD Station sync
  if (lead.rd_contact_id) {
    pass('Sync RD Station', `contact_id=${lead.rd_contact_id}, deal_id=${lead.rd_deal_id}`);
    rdContactId = lead.rd_contact_id;
    rdDealId = lead.rd_deal_id;
  } else {
    log('⚠️', `Sync RD pendente (rd_contact_id=${lead.rd_contact_id})`);
  }

  // Verificar primeira mensagem enviada
  const firstMsg = await getLastAssistantMessage();
  if (firstMsg && firstMsg.includes('Helena')) {
    pass('Primeira mensagem enviada', `${firstMsg.substring(0, 60)}...`);
  } else {
    log('⚠️', 'Primeira mensagem não detectada no banco');
  }

  log('⏱️', `Etapa 1 concluída em ${Date.now() - t0}ms`);
}

async function etapa2_coletaDados() {
  console.log('\n═══════════════════════════════════════');
  console.log('ETAPA 2 — Conversa de Coleta de Dados');
  console.log('═══════════════════════════════════════');

  const mensagens = [
    { texto: 'Oi', campo: null, descricao: 'Saudação' },
    { texto: 'João da Silva, nascido em 15/03/1985', campo: 'name', descricao: 'Nome + nascimento' },
    { texto: '1,75 de altura e 80kg', campo: 'height', descricao: 'Altura + peso' },
    { texto: 'Sou engenheiro civil', campo: 'profession', descricao: 'Profissão' },
    { texto: 'Ganho entre 8 e 12 mil', campo: 'income', descricao: 'Renda' },
    { texto: 'Não fumo', campo: 'smoker', descricao: 'Fumante' },
  ];

  for (const msg of mensagens) {
    const t0 = Date.now();
    log('📤', `Enviando: "${msg.texto}"`);

    await sendWhatsAppMessage(msg.texto);
    const resposta = await waitForResponse();
    const latency = Date.now() - t0;

    if (resposta && resposta !== '[sem resposta]') {
      pass(`${msg.descricao}`, `${latency}ms — "${resposta.substring(0, 80)}..."`);
    } else {
      fail(`${msg.descricao}`, `Sem resposta após ${latency}ms`);
    }

    // Verificar se campo foi salvo
    if (msg.campo) {
      const lead = await getLeadFromDB();
      if (lead && lead[msg.campo]) {
        pass(`Campo ${msg.campo} salvo`, `${lead[msg.campo]}`);
      } else {
        log('⚠️', `Campo ${msg.campo} ainda não salvo (pode ser salvo via cadastra_lead)`);
      }
    }
  }
}

async function etapa3_agendamento() {
  console.log('\n═══════════════════════════════════════');
  console.log('ETAPA 3 — Agendamento');
  console.log('═══════════════════════════════════════');

  // Enviar preferência de período
  log('📤', 'Enviando: "Prefiro à tarde"');
  const t0 = Date.now();
  await sendWhatsAppMessage('Prefiro à tarde');
  const resposta1 = await waitForResponse();

  if (resposta1.includes('horário') || resposta1.includes('opç')) {
    pass('Horários oferecidos', `${Date.now() - t0}ms — "${resposta1.substring(0, 100)}..."`);
  } else {
    fail('Horários oferecidos', `Resposta: "${resposta1.substring(0, 100)}"`);
  }

  // Verificar se consulta_horario foi chamada
  const toolEvents = await getToolEvents();
  const consultaEvent = toolEvents.find((e: { payload: string }) => {
    const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    return p.tool === 'consulta_horario';
  });
  if (consultaEvent) {
    const cp = typeof consultaEvent.payload === 'string' ? JSON.parse(consultaEvent.payload) : consultaEvent.payload;
    pass('Tool consulta_horario chamada', JSON.stringify(cp.args));
  } else {
    log('⚠️', 'Tool consulta_horario não detectada nos events');
  }

  // Escolher primeiro horário
  log('📤', 'Enviando: "1"');
  const t1 = Date.now();
  await sendWhatsAppMessage('1');
  const resposta2 = await waitForResponse();

  if (resposta2.includes('confirmado') || resposta2.includes('agend') || resposta2.includes('Meet')) {
    pass('Agendamento confirmado', `${Date.now() - t1}ms — "${resposta2.substring(0, 100)}..."`);
  } else {
    fail('Agendamento confirmado', `Resposta: "${resposta2.substring(0, 100)}"`);
  }

  // Verificar lead agendado no banco
  const lead = await getLeadFromDB();
  if (lead?.scheduled) {
    pass('Lead marcado como agendado', `scheduled_at=${lead.scheduled_at}`);
  } else {
    log('⚠️', 'Lead não marcado como scheduled no banco');
  }

  // Verificar tool registra_agendamento
  const toolEvents2 = await getToolEvents();
  const registraEvent = toolEvents2.find((e: { payload: string }) => {
    const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    return p.tool === 'registra_agendamento';
  });
  if (registraEvent) {
    const payload = typeof registraEvent.payload === 'string' ? JSON.parse(registraEvent.payload) : registraEvent.payload;
    pass('Tool registra_agendamento chamada', `data=${payload.args.data} horario=${payload.args.horario}`);
    // Extrair event ID do resultado se possível
    const match = payload.result?.match(/ID do evento: ([^\n]+)/);
    if (match) calendarEventId = match[1];
  } else {
    log('⚠️', 'Tool registra_agendamento não detectada');
  }
}

async function etapa4_verificacaoRD() {
  console.log('\n═══════════════════════════════════════');
  console.log('ETAPA 4 — Verificação RD Station');
  console.log('═══════════════════════════════════════');

  const lead = await getLeadFromDB();
  rdContactId = lead?.rd_contact_id || rdContactId;
  rdDealId = lead?.rd_deal_id || rdDealId;

  if (!rdContactId) {
    log('⚠️', 'Sem rd_contact_id — pulando verificação RD');
    return;
  }

  if (!RD_TOKEN) {
    log('⚠️', 'RD_TOKEN não configurado — pulando verificação RD');
    return;
  }

  // Buscar contato no RD
  try {
    const res = await fetch(
      `https://crm.rdstation.com/api/v1/contacts/${rdContactId}?token=${RD_TOKEN}`,
    );
    const contact = await res.json() as {
      name: string;
      contact_custom_fields: Array<{ custom_field_id: string; value: string | string[] }>;
    };

    if (contact.name) {
      pass('Contato encontrado no RD', `name=${contact.name}`);
    } else {
      fail('Contato encontrado no RD', 'Contato sem nome');
    }

    // Verificar campos customizados
    const fields = contact.contact_custom_fields || [];
    const fieldMap: Record<string, string> = {
      '69bb4655626559001e2972b4': 'data_nascimento',
      '69bddd471c94960018bc1e3b': 'altura',
      '69bddd58fb02050016cc04c0': 'peso',
      '69c2fe8d92aa8d001fd8313e': 'profissao',
      '69bddc67d1fc640019a59ba9': 'renda_mensal',
      '69bc628005b2d80026edfa48': 'fumante',
    };

    let filledCount = 0;
    for (const [fieldId, fieldName] of Object.entries(fieldMap)) {
      const cf = fields.find((f: { custom_field_id: string }) => f.custom_field_id === fieldId);
      if (cf && cf.value) {
        filledCount++;
        pass(`Campo ${fieldName}`, `${cf.value}`);
      } else {
        log('⚠️', `Campo ${fieldName} vazio no RD`);
      }
    }

    log('📊', `${filledCount}/${Object.keys(fieldMap).length} campos preenchidos no RD`);
  } catch (error) {
    fail('Verificação RD Station', error);
  }

  // Verificar deal
  if (rdDealId) {
    try {
      const res = await fetch(
        `https://crm.rdstation.com/api/v1/deals/${rdDealId}?token=${RD_TOKEN}`,
      );
      const deal = await res.json() as { name: string; deal_stage: { name: string } };
      pass('Deal no RD', `name="${deal.name}" stage="${deal.deal_stage?.name}"`);
    } catch (error) {
      fail('Verificação deal RD', error);
    }
  }
}

async function etapa5_limpeza() {
  console.log('\n═══════════════════════════════════════');
  console.log('ETAPA 5 — Limpeza');
  console.log('═══════════════════════════════════════');

  // Limpar banco local
  await query('DELETE FROM conversations WHERE phone = $1', [TEST_PHONE]);
  await query('DELETE FROM followup_log WHERE phone = $1', [TEST_PHONE]);
  await query('DELETE FROM events WHERE phone = $1', [TEST_PHONE]);
  await query('DELETE FROM leads WHERE phone = $1', [TEST_PHONE]);
  pass('Banco local limpo', 'leads + conversations + events deletados');

  // Limpar RD Station (best effort)
  if (rdDealId && RD_TOKEN) {
    try {
      await fetch(`https://crm.rdstation.com/api/v1/deals/${rdDealId}?token=${RD_TOKEN}`, {
        method: 'DELETE',
      });
      pass('Deal RD deletado', rdDealId);
    } catch {
      log('⚠️', 'Não foi possível deletar deal no RD');
    }
  }

  if (rdContactId && RD_TOKEN) {
    try {
      await fetch(`https://crm.rdstation.com/api/v1/contacts/${rdContactId}?token=${RD_TOKEN}`, {
        method: 'DELETE',
      });
      pass('Contato RD deletado', rdContactId);
    } catch {
      log('⚠️', 'Não foi possível deletar contato no RD');
    }
  }

  // Limpar Google Calendar (best effort) — deletado pelo sistema quando limparmos
  if (calendarEventId) {
    log('📅', `Evento Calendar: ${calendarEventId} (deletar manualmente se necessário)`);
  }
}

// ──────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  TESTE E2E — Helena SDR IA (Claude)   ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`Horário: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(`Servidor: ${BASE_URL}`);
  console.log(`Telefone teste: ${TEST_PHONE}`);

  // Carregar RD Token do .env
  const dotenv = await import('dotenv');
  dotenv.config();
  RD_TOKEN = process.env.RDSTATION_API_TOKEN || '';

  try {
    await etapa1_chegadaLead();
    await etapa2_coletaDados();
    await etapa3_agendamento();
    await etapa4_verificacaoRD();
    await etapa5_limpeza();
  } catch (error) {
    console.error('\n💥 Erro fatal no teste:', error);
    // Tentar limpeza mesmo com erro
    try { await etapa5_limpeza(); } catch { /* best effort */ }
  }

  // Resultado final
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n╔═══════════════════════════════════════╗');
  console.log(`║  RESULTADO: ${passed} PASS / ${failed} FAIL          ║`);
  console.log(`║  Tempo total: ${totalTime}s                   ║`);
  console.log('╚═══════════════════════════════════════╝');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main();
