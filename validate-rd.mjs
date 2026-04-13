import pg from 'pg';

import dotenv from 'dotenv';
dotenv.config();
const RD_TOKEN = process.env.RDSTATION_API_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao configurado. Rode com: DATABASE_URL=... node validate-rd.mjs');
  process.exit(1);
}

const CF_IDS = {
  '69bb4655626559001e2972b4': 'birth_date',
  '69bddd471c94960018bc1e3b': 'height',
  '69bddd58fb02050016cc04c0': 'weight',
  '69c2fe8d92aa8d001fd8313e': 'profession',
  '69bddc67d1fc640019a59ba9': 'income',
  '69bc628005b2d80026edfa48': 'smoker',
  '69bd76d25047c3001da71f9f': 'cpf',
  '69bb46a542ab9c00191305f8': 'children',
  '69d39f982108b8001335a66e': 'state',
  '69b56c7f724f3f0017575ba2': 'resumo_vendedor',
};

const DB_FIELDS = ['birth_date', 'height', 'weight', 'profession', 'income', 'smoker', 'cpf'];

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const { rows: leads } = await pool.query(`
    SELECT name, phone, rd_contact_id, birth_date, height, weight, profession, income, smoker, cpf, children, scheduled
    FROM leads
    WHERE rd_contact_id IS NOT NULL
      AND status IN ('active', 'exhausted')
      AND (birth_date IS NOT NULL OR height IS NOT NULL OR profession IS NOT NULL)
    ORDER BY created_at DESC
  `);

  console.log(`\n=== VALIDAÇÃO RD STATION ===`);
  console.log(`Leads com dados no banco: ${leads.length}\n`);

  let totalOk = 0;
  let totalIncomplete = 0;
  let totalMissing = 0;
  const issues = [];

  for (const lead of leads) {
    const res = await fetch(`https://crm.rdstation.com/api/v1/contacts/${lead.rd_contact_id}?token=${RD_TOKEN}`);
    if (!res.ok) {
      console.log(`✗ ${lead.name || lead.phone}: contato não encontrado no RD (${res.status})`);
      totalMissing++;
      continue;
    }

    const contact = await res.json();
    const rdFields = {};
    for (const f of (contact.contact_custom_fields || [])) {
      const label = CF_IDS[f.custom_field_id];
      if (label && f.value) rdFields[label] = f.value;
    }

    // Comparar campos do banco vs RD
    const missing = [];
    for (const field of DB_FIELDS) {
      if (lead[field] && !rdFields[field]) {
        missing.push(field);
      }
    }
    // Estado sempre deveria estar preenchido
    if (!rdFields.state) missing.push('state');

    if (missing.length === 0) {
      console.log(`✓ ${(lead.name || lead.phone).padEnd(30)} | RD: ${Object.keys(rdFields).length} campos`);
      totalOk++;
    } else {
      console.log(`✗ ${(lead.name || lead.phone).padEnd(30)} | Faltam no RD: ${missing.join(', ')}`);
      issues.push({ name: lead.name, phone: lead.phone, missing });
      totalIncomplete++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== RESUMO ===`);
  console.log(`Total verificados: ${leads.length}`);
  console.log(`OK (completos): ${totalOk}`);
  console.log(`Incompletos: ${totalIncomplete}`);
  console.log(`Não encontrados: ${totalMissing}`);

  if (issues.length > 0) {
    console.log(`\n=== LEADS COM CAMPOS FALTANTES ===`);
    for (const i of issues) {
      console.log(`  ${i.name || i.phone}: ${i.missing.join(', ')}`);
    }
  } else {
    console.log(`\n✓ TODOS os leads sincronizados corretamente`);
  }

  await pool.end();
}

main().catch(console.error);
