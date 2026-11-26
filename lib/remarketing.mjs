// Remarketing automático por modelos de marketing do WhatsApp — regras puras (testadas em tests/remarketing.test.mjs).
// Quem decide o envio é o banco (wa_remarketing_run): quem recebe, por qual número, horário, limite e modelo aprovado.
// Decisão do dono (Regtech): vai para todos os leads que ficaram N dias sem responder, menos Ganho e quem pediu
// para sair. SAIR/PARAR continua obrigatório.

export const REMARKETING_PADRAO = {enabled: false, days: 10, max_attempts: 3, daily_limit: 50, send_days: 'seg-sab', start: '09:00', end: '18:00'};
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Valida settings.remarketing (ausente = desligado, válido). */
export function remarketingValido(r) {
  if (r === undefined || r === null) return true;
  if (typeof r !== 'object' || Array.isArray(r)) return false;
  if (typeof r.enabled !== 'boolean') return false;
  if (r.days !== undefined && !inteiro(r.days, 1, 90)) return false;
  if (r.max_attempts !== undefined && !inteiro(r.max_attempts, 1, 3)) return false;
  if (r.daily_limit !== undefined && !inteiro(r.daily_limit, 1, 1000)) return false;
  if (r.send_days !== undefined && !['seg-sex', 'seg-sab'].includes(r.send_days)) return false;
  for (const k of ['start', 'end']) if (r[k] !== undefined && !(typeof r[k] === 'string' && HORA.test(r[k]))) return false;
  if ((r.start ?? '09:00') >= (r.end ?? '18:00')) return false;
  if (r.templates !== undefined && !(Array.isArray(r.templates) && r.templates.length >= 1 && r.templates.length <= 3
    && r.templates.every(t => typeof t === 'string' && /^[a-z0-9_]{1,512}$/.test(t)))) return false;
  return true;
}

export function lerRemarketing(settings) {
  const r = settings?.remarketing;
  return r && remarketingValido(r) ? {...REMARKETING_PADRAO, ...r} : {...REMARKETING_PADRAO};
}

// Os três modelos (MARKETING, pt_BR), um por tentativa; {{1}} = primeiro nome (ou "tudo bem" se o nome não for válido).
// Começam com "Oi, {{1}}!": a Meta recusa modelo que começa com variável.
export const MODELOS_REMARKETING = [
  {name: 'remarketing_parcela', language: 'pt_BR', category: 'MARKETING', examples: ['João'],
    text: 'Oi, {{1}}! A sua moto elétrica cabe no bolso: no cartão em até 12x ou 4x sem juros 🛵⚡ Sem gasolina, sem IPVA alto, sem fila no posto. Quer que eu te mande as opções que cabem na sua parcela? Responda SIM. (Para não receber mais, responda SAIR)'},
  {name: 'remarketing_economia', language: 'pt_BR', category: 'MARKETING', examples: ['João'],
    text: 'Oi, {{1}}! Quanto você gasta de gasolina por mês? Com elétrica, a recarga custa uma fração disso, e a moto se paga com a economia. Te mostro a conta com o seu uso? Responda SIM. (SAIR para não receber)'},
  {name: 'remarketing_ultima', language: 'pt_BR', category: 'MARKETING', examples: ['João'],
    text: 'Oi, {{1}}! Última mensagem da Regtech Motors pra você 🙂 Se ainda quiser sair do ônibus ou da gasolina, vem fazer um test drive na loja ou me chama aqui que eu resolvo. Se não for o momento, tudo bem, é só responder SAIR.'},
];

/** Linha do relatório diário. @param {{enviados?:number, responderam?:number}|null|undefined} r */
export function linhaDoRemarketing(r) {
  if (!r) return '';
  return `remarketing: ${r.enviados || 0} ${r.enviados === 1 ? 'enviado' : 'enviados'}, ${r.responderam || 0} ${r.responderam === 1 ? 'respondeu' : 'responderam'}`;
}

const RESULTADO = {queued: 'Na fila', sent: 'Enviado', delivered: 'Entregue', read: 'Lido', failed: 'Falhou'};
const DESFECHO = {responded: 'Respondeu', opt_out: 'Pediu para sair'};
export const COLUNAS_PLANILHA = ['Data', 'Lead', 'Número da loja', 'Tentativa', 'Modelo', 'Resultado', 'Erro', 'Resposta', 'Respondeu em'];

/** Linhas da planilha do painel (um envio por linha). */
export function linhasDaPlanilha(envios) {
  return (envios || []).map(e => [
    e.created_at ? new Date(e.created_at).toLocaleString('pt-BR', {timeZone: 'America/Sao_Paulo'}) : '',
    e.lead?.nome || e.lead?.data?.name || '',
    e.account?.phone_e164 || '',
    e.attempt ?? '',
    e.template_name || '',
    RESULTADO[e.message?.message_status] || e.message?.message_status || '',
    e.message?.error_code || '',
    DESFECHO[e.outcome] || '',
    e.responded_at ? new Date(e.responded_at).toLocaleString('pt-BR', {timeZone: 'America/Sao_Paulo'}) : '',
  ]);
}
