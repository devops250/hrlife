import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'consulta_horario',
      description: 'Consulta os próximos horários disponíveis na agenda do especialista para o período indicado (manhã, tarde ou noite). Sempre chamar antes de sugerir horários ao lead.',
      parameters: {
        type: 'object',
        properties: {
          periodo: {
            type: 'string',
            enum: ['manha', 'tarde', 'noite'],
            description: 'Período preferido pelo lead',
          },
        },
        required: ['periodo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registra_agendamento',
      description: 'Registra o agendamento na agenda do especialista. Chamar quando o lead escolher um dos horários oferecidos.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: 'Data do agendamento no formato YYYY-MM-DD',
          },
          horario: {
            type: 'string',
            description: 'Horário do agendamento no formato HH:MM',
          },
          nome_lead: {
            type: 'string',
            description: 'Nome completo do lead',
          },
        },
        required: ['data', 'horario', 'nome_lead'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cadastra_lead',
      description: 'Cadastra ou atualiza os dados do lead no sistema. Chamar após coleta completa dos dados (agendado=false) e novamente após agendar (agendado=true).',
      parameters: {
        type: 'object',
        properties: {
          nome_completo: { type: 'string', description: 'Nome completo do lead' },
          data_nascimento: { type: 'string', description: 'Data de nascimento (DD/MM/AAAA)' },
          cpf: { type: 'string', description: 'CPF do lead (opcional)' },
          altura: { type: 'string', description: 'Altura (ex: 1,75)' },
          peso: { type: 'string', description: 'Peso (ex: 80kg)' },
          profissao: { type: 'string', description: 'Profissão específica' },
          renda_mensal: { type: 'string', description: 'Renda mensal ou faixa' },
          fumante: { type: 'string', description: 'Se fuma ou fumou nos últimos 24 meses (sim/não)' },
          agendado: { type: 'string', enum: ['true', 'false'], description: 'Se o lead já agendou apresentação' },
        },
        required: ['nome_completo', 'agendado'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancela_agendamento',
      description: 'Cancela o agendamento do lead. Usar apenas após confirmação explícita do lead.',
      parameters: {
        type: 'object',
        properties: {
          nome_lead: {
            type: 'string',
            description: 'Nome do lead para localizar o evento',
          },
        },
        required: ['nome_lead'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_agendamento',
      description: 'Reagenda a apresentação para um novo horário. Usar apenas após confirmação explícita do lead.',
      parameters: {
        type: 'object',
        properties: {
          nome_lead: {
            type: 'string',
            description: 'Nome do lead para localizar o evento atual',
          },
          nova_data: {
            type: 'string',
            description: 'Nova data no formato YYYY-MM-DD',
          },
          novo_horario: {
            type: 'string',
            description: 'Novo horário no formato HH:MM',
          },
        },
        required: ['nome_lead', 'nova_data', 'novo_horario'],
      },
    },
  },
];
