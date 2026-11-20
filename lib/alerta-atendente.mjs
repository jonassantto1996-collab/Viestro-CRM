// Alerta no WhatsApp do atendente quando o agente passa uma conversa para ele.
// Regras puras (testadas em tests/alerta-atendente.test.mjs). O envio sai do número da
// empresa com um modelo UTILITY aprovado pela Meta; sem modelo aprovado, nada é enviado.

export const ALERTA_MODELO = {name: 'alerta_atendimento', language: 'pt_BR'};
// Texto do modelo a cadastrar na Meta (categoria UTILITY):
export const ALERTA_TEXTO = 'Olá, {{1}}! Novo atendimento esperando você no CRM da Regtech: {{2}}. Abra o CRM para responder o cliente.';

// Telefone do atendente: só dígitos, com DDI. Número brasileiro sem DDI (10 ou 11 dígitos) ganha o 55.
export function normalizarTelefone(t) {
  const d = String(t ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 || d.length === 11 ? '55' + d : d;
}
export function telefoneValido(t) {
  return typeof t === 'string' && /^[1-9]\d{9,14}$/.test(t);
}

// Mapa nome → telefone salvo em settings.agent.attendant_phones (opcional).
export function telefonesValidos(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== 'object' || Array.isArray(m)) return false;
  const entradas = Object.entries(m);
  if (entradas.length > 5) return false;
  return entradas.every(([nome, tel]) => nome.trim() && nome.length <= 40 && telefoneValido(tel));
}

export function telefoneDoAtendente(agente, nome) {
  const m = agente?.attendant_phones;
  if (!nome || !m || typeof m !== 'object') return null;
  const t = m[nome];
  return telefoneValido(t) ? t : null;
}

// A Meta recusa parâmetro com quebra de linha, tab ou mais de 4 espaços seguidos.
const limpar = (t, max) => String(t ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);

/** @param {{atendente:any, cliente:any, motivo?:any, quente?:boolean}} p */
export function textoDoAlerta({atendente, cliente, motivo = '', quente = false}) {
  const quem = limpar(cliente, 60) || 'cliente do WhatsApp';
  const porque = limpar(motivo, 120);
  return {
    nome: limpar(atendente, 40) || 'equipe',
    detalhe: `${quente ? '🔥 Lead quente — ' : ''}${quem}${porque ? ` (${porque})` : ''}`,
  };
}

/** Corpo do envio (payload do tipo "template", o mesmo formato da fila do WhatsApp). */
export function envioDoAlerta(p) {
  const {nome, detalhe} = textoDoAlerta(p);
  return {template: {name: ALERTA_MODELO.name, language: {code: ALERTA_MODELO.language},
    components: [{type: 'body', parameters: [{type: 'text', text: nome}, {type: 'text', text: detalhe}]}]}};
}

// Avisar de novo só quando a passagem é nova ou quando a conversa acabou de ficar quente.
/** @param {{antes: null | {hot?: boolean}, quente: boolean}} p */
export function deveAvisar({antes, quente}) {
  if (!antes) return true;
  return quente && antes.hot !== true;
}

// Conversa do próprio atendente (ele respondeu o alerta): o agente não responde.
export function ehAtendente(agente, waId) {
  const m = agente?.attendant_phones;
  if (!waId || !m || typeof m !== 'object') return false;
  return Object.values(m).some(t => t === String(waId));
}
