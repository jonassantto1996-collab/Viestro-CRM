// Relatório diário no WhatsApp de um atendente (ex.: Agna), no fechamento da loja.
// Regras puras (testadas em tests/relatorio-diario.test.mjs). Sai pelo número da empresa com o
// modelo UTILITY "relatorio_diario" aprovado pela Meta; sem modelo aprovado, nada é enviado.
import {AGENTE_PADRAO, dentroDoExpediente} from './agente.mjs';
import {ALERTA_MODELO, ALERTA_TEXTO, ALERTA_EXEMPLO} from './alerta-atendente.mjs';

export const RELATORIO_MODELO = {name: 'relatorio_diario', language: 'pt_BR'};
// Texto do modelo a cadastrar na Meta (categoria UTILITY):
export const RELATORIO_TEXTO = 'Olá, {{1}}! Resumo de hoje no CRM da Regtech: {{2}}. Abra o CRM para ver os detalhes.';
export const RELATORIO_EXEMPLO = ['Agna', '8 conversas novas · 3 leads quentes · passagens: Agna 2, Cleudo 1 · 4 atendimentos em aberto'];

const FUSO = 'America/Sao_Paulo';
/** Dia de hoje em Brasília (AAAA-MM-DD). */
export function diaDeHoje(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: FUSO}).format(agora);
}

/**
 * Está na hora do relatório? Só em dia de loja aberta, do fechamento até 23:59 (se o relógio
 * atrasar, ainda sai no mesmo dia). O banco garante um envio por dia.
 */
export function horaDoRelatorio(agente, agora = new Date()) {
  const cfg = {...AGENTE_PADRAO, ...agente};
  if (!cfg.enabled || !cfg.store_hours || !cfg.daily_report) return false;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
    .formatToParts(agora).map(x => [x.type, x.value]));
  const uteis = cfg.office_days === 'seg-sab' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (!uteis.includes(p.weekday)) return false;
  return `${p.hour}:${p.minute}` >= cfg.office_end && !dentroDoExpediente(cfg, agora);
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
/**
 * Linha única (a Meta recusa quebra de linha em variável).
 * @param {{novas?:number, quentes?:number, passagens?:Record<string, number>, abertas?:number}} d
 */
export function textoDoRelatorio(d = {}) {
  const passagens = Object.entries(d.passagens || {}).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]).map(([nome, n]) => `${String(nome).replace(/[\r\n\t]+/g, ' ').slice(0, 40)} ${n}`);
  return [
    plural(d.novas || 0, 'conversa nova', 'conversas novas'),
    plural(d.quentes || 0, 'lead quente', 'leads quentes'),
    passagens.length ? `passagens: ${passagens.join(', ')}` : 'nenhuma passagem para a equipe',
    plural(d.abertas || 0, 'atendimento em aberto', 'atendimentos em aberto'),
  ].join(' · ').slice(0, 900);
}

/** Corpo do envio (payload do tipo "template"). */
export function envioDoRelatorio(nome, dados) {
  return {template: {name: RELATORIO_MODELO.name, language: {code: RELATORIO_MODELO.language},
    components: [{type: 'body', parameters: [{type: 'text', text: String(nome || 'equipe').slice(0, 40)}, {type: 'text', text: textoDoRelatorio(dados)}]}]}};
}

/** Modelos que o CRM usa para falar com a equipe (criados no WasapFlow pelo dono da plataforma). */
export function modelosDaEquipe() {
  return [
    {...ALERTA_MODELO, text: ALERTA_TEXTO, examples: ALERTA_EXEMPLO},
    {...RELATORIO_MODELO, text: RELATORIO_TEXTO, examples: RELATORIO_EXEMPLO},
  ];
}
