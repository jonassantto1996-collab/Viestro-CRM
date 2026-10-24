// Dados fictícios da demonstração (pet shop). Nenhum número ou pessoa real.
const min = 60_000;
const hour = 60 * min;

function at(msAgo: number) {
  return new Date(Date.now() - msAgo).toISOString();
}

type DemoMsg = [direction: 'inbound' | 'outbound', source: string, body: string, msAgo: number, status?: string, error?: string];

function thread(id: string, items: DemoMsg[]) {
  return items.map(([direction, source, body, msAgo, status, error], i) => ({
    id: `${id}-m${i}`,
    direction,
    source,
    message_type: 'text',
    body,
    template_name: null,
    message_status: status || (direction === 'inbound' ? 'received' : 'read'),
    error_code: error || null,
    sent_by_user_id: source === 'crm' ? 'm2' : null,
    at: at(msAgo),
  }));
}

export function waDemo() {
  const account = {id: 'acc-demo', phone_e164: '+5594900000000', display_name: 'Pet Shop Demonstração', connection_status: 'connected'};
  const conv = (id: string, name: string, phone: string, extra: any, messages: any[]) => {
    const inbound = messages.filter(m => m.direction === 'inbound');
    const outbound = messages.filter(m => m.direction === 'outbound');
    const last = messages[messages.length - 1];
    const lastIn = inbound[inbound.length - 1]?.at || null;
    const lastOut = outbound[outbound.length - 1]?.at || null;
    const windowEnd = lastIn ? new Date(new Date(lastIn).getTime() + 24 * hour).toISOString() : null;
    return {
      conversation: {
        id, status: 'open', category: null, unread_count: 0, assigned_user_id: null,
        last_message_at: last.at, last_message_preview: last.body.slice(0, 160),
        last_inbound_at: lastIn, last_outbound_at: lastOut, first_inbound_at: inbound[0]?.at || null,
        first_response_at: outbound.find(o => inbound[0] && o.at > inbound[0].at)?.at || null,
        service_window_expires_at: windowEnd,
        contact: {id: `c-${id}`, name, phone_e164: phone, crm_lead_id: null, marketing_opt_out_at: null},
        account,
        ...extra,
      },
      messages,
    };
  };

  const list = [
    conv('d1', 'Maria Souza', '+5594981110001', {unread_count: 2, category: 'Banho e tosa'}, thread('d1', [
      ['inbound', 'api_inbound', 'Oi, boa tarde! Vocês têm horário para banho e tosa amanhã?', 14 * min],
      ['inbound', 'api_inbound', 'É uma shih-tzu de 4 anos 🐶', 13 * min],
    ])),
    conv('d2', 'João do Rex', '+5594981110002', {category: 'Produtos', assigned_user_id: 'm2'}, thread('d2', [
      ['inbound', 'api_inbound', 'Qual o preço da ração Golden 15 kg?', 2 * hour],
      ['outbound', 'app_echo', 'Oi, João! A Golden 15 kg está R$ 189,90. Quer que separe uma?', 110 * min],
      ['inbound', 'api_inbound', 'Pode separar, passo aí às 18h', 100 * min],
      ['outbound', 'crm', 'Combinado! Fica separada no seu nome. 😉', 95 * min, 'read'],
    ])),
    conv('d3', 'Carla Lima', '+5594981110003', {category: 'Serviços', status: 'pending', assigned_user_id: 'm1'}, thread('d3', [
      ['inbound', 'api_inbound', 'Vocês aplicam vacina V10? Qual o valor?', 5 * hour],
      ['outbound', 'crm', 'Aplicamos sim! A V10 sai por R$ 95,00 com a aplicação. Posso agendar?', 4.8 * hour, 'delivered'],
    ])),
    conv('d4', 'Ana Beatriz', '+5594981110004', {unread_count: 1}, thread('d4', [
      ['inbound', 'api_inbound', 'Vocês abrem domingo?', 40 * min],
    ])),
    conv('d6', '', '+5594981110006', {unread_count: 1}, thread('d6', [
      ['inbound', 'api_inbound', 'Boa tarde, vocês fazem entrega de ração?', 3 * min],
    ])),
    conv('d5', 'Pedro Alves', '+5594981110005', {category: 'Banho e tosa', status: 'resolved'}, thread('d5', [
      ['inbound', 'history_sync', 'Quero agendar a tosa do Thor', 30 * hour],
      ['outbound', 'history_sync', 'Agendado para sábado às 9h! 🐾', 29.5 * hour],
      ['inbound', 'history_sync', 'Obrigado!', 29 * hour],
    ])),
  ];
  return {
    conversations: list.map(x => x.conversation),
    messages: Object.fromEntries(list.map(x => [x.conversation.id, x.messages])) as Record<string, any[]>,
    templates: [
      {id: 't1', account_id: 'acc-demo', name: 'lembrete_horario', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED',
        components: [{type: 'BODY', text: 'Olá {{1}}! Lembrete do seu horário no Pet Shop: {{2}}. Responda esta mensagem se precisar remarcar.'}]},
      {id: 't2', account_id: 'acc-demo', name: 'retorno_atendimento', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED',
        components: [{type: 'BODY', text: 'Olá {{1}}! Passando para saber se ficou alguma dúvida sobre seu atendimento. Estamos à disposição.'}]},
      {id: 't3', account_id: 'acc-demo', name: 'promo_banho', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED',
        components: [{type: 'BODY', text: 'Olá {{1}}! Esta semana o banho tem 20% de desconto. Quer garantir um horário?'}]},
    ],
  };
}
