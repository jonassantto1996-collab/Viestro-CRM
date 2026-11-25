import test from 'node:test';
import assert from 'node:assert/strict';
import {horaDoRelatorio, textoDoRelatorio, envioDoRelatorio, diaDeHoje, RELATORIO_MODELO, RELATORIO_TEXTO} from '../lib/relatorio-diario.mjs';
import {agenteValido, donosValidos, proximaAbertura, situacaoDaLoja, quandoAvisar, quandoAbre, montarPedido} from '../lib/agente.mjs';

// Brasília = UTC-3. 2026-11-25 é quarta-feira; 2026-11-28 é sábado.
const br = (s) => new Date(`${s}-03:00`);
const LOJA = {enabled: true, name: 'Ana', tone: 'descontraido', knowledge: 'Base de conhecimento com mais de trinta letras aqui.', handoff: '',
  mode: 'automatico', store_hours: true, office_days: 'seg-sab', office_start: '08:00', office_end: '18:00',
  attendants: ['Agna', 'Cleudo'], attendant_phones: {Agna: '5594991111111', Cleudo: '5594992222222'},
  number_owners: {'5594992086088': 'Agna', '5594993091715': 'Cleudo'}, daily_report: 'Agna'};

test('configuração nova é válida; dono de número e relatório validados', () => {
  assert.equal(agenteValido(LOJA), true);
  assert.equal(donosValidos(undefined), true);
  assert.equal(donosValidos({'5594992086088': 'Agna'}), true);
  assert.equal(donosValidos({'6088': 'Agna'}), false);
  assert.equal(donosValidos({'5594992086088': ''}), false);
  assert.equal(donosValidos([]), false);
  assert.equal(agenteValido({...LOJA, store_hours: 'sim'}), false);
  assert.equal(agenteValido({...LOJA, daily_report: 'x'.repeat(41)}), false);
  assert.equal(agenteValido({...LOJA, number_owners: {abc: 'Agna'}}), false);
});

test('loja aberta: alerta sai agora; fechada: na próxima abertura', () => {
  const aberta = br('2026-11-25T10:00:00');
  assert.deepEqual(situacaoDaLoja(LOJA, aberta), {aberta: true, abre: null});
  assert.equal(quandoAvisar(LOJA, aberta), aberta);
  const noite = br('2026-11-25T22:30:00');
  assert.equal(quandoAvisar(LOJA, noite).toISOString(), br('2026-11-26T08:00:00').toISOString());
  const madrugada = br('2026-11-26T03:00:00');
  assert.equal(proximaAbertura(LOJA, madrugada).toISOString(), br('2026-11-26T08:00:00').toISOString());
  // Sábado à noite (seg-sab): pula o domingo
  assert.equal(proximaAbertura(LOJA, br('2026-11-28T19:00:00')).toISOString(), br('2026-11-30T08:00:00').toISOString());
  // seg-sex: sexta à noite vai para segunda
  assert.equal(proximaAbertura({...LOJA, office_days: 'seg-sex'}, br('2026-11-27T19:00:00')).toISOString(), br('2026-11-30T08:00:00').toISOString());
  // Sem horário da loja: tudo como antes (alerta na hora)
  const semHorario = {...LOJA, store_hours: false};
  assert.equal(situacaoDaLoja(semHorario, noite), null);
  assert.equal(quandoAvisar(semHorario, noite), noite);
});

test('quando abre, em português', () => {
  assert.equal(quandoAbre(br('2026-11-26T08:00:00'), br('2026-11-25T22:00:00')), 'amanhã às 08:00');
  assert.equal(quandoAbre(br('2026-11-26T08:00:00'), br('2026-11-26T03:00:00')), 'hoje às 08:00');
  assert.equal(quandoAbre(br('2026-11-30T08:00:00'), br('2026-11-28T19:00:00')), 'segunda-feira às 08:00');
  assert.equal(quandoAbre(null), '');
});

test('agente fora do horário avisa o cliente que o atendente responde na abertura (na mensagem, não nas instruções)', () => {
  const base = {empresa: 'Regtech', nicho: 'motos', agente: LOJA, contato: 'João', mensagens: [{direction: 'inbound', message_type: 'text', body: 'oi', at: new Date().toISOString()}], automatico: true};
  const noite = montarPedido({...base, agora: br('2026-11-25T22:00:00')});
  assert.match(noite.usuario, /loja está fechada agora \(abre amanhã às 08:00\)/);
  const dia = montarPedido({...base, agora: br('2026-11-25T10:00:00')});
  assert.doesNotMatch(dia.usuario, /fechada/);
  assert.equal(noite.sistema, dia.sistema); // instruções iguais: o cache continua valendo
  // Modo sugestão e empresa sem horário da loja: sem o aviso
  assert.doesNotMatch(montarPedido({...base, automatico: false, agora: br('2026-11-25T22:00:00')}).usuario, /fechada/);
  assert.doesNotMatch(montarPedido({...base, agente: {...LOJA, store_hours: false}, agora: br('2026-11-25T22:00:00')}).usuario, /fechada/);
});

test('relatório: só em dia de loja, do fechamento até o fim do dia, com destinatário', () => {
  assert.equal(horaDoRelatorio(LOJA, br('2026-11-25T17:59:00')), false);
  assert.equal(horaDoRelatorio(LOJA, br('2026-11-25T18:00:00')), true);
  assert.equal(horaDoRelatorio(LOJA, br('2026-11-25T23:30:00')), true);
  assert.equal(horaDoRelatorio(LOJA, br('2026-11-29T18:30:00')), false); // domingo
  assert.equal(horaDoRelatorio({...LOJA, daily_report: ''}, br('2026-11-25T18:30:00')), false);
  assert.equal(horaDoRelatorio({...LOJA, store_hours: false}, br('2026-11-25T18:30:00')), false);
  assert.equal(horaDoRelatorio({...LOJA, enabled: false}, br('2026-11-25T18:30:00')), false);
  assert.equal(diaDeHoje(br('2026-11-25T23:30:00')), '2026-11-25');
});

test('texto do relatório: uma linha, plural certo, passagens por atendente', () => {
  assert.equal(textoDoRelatorio({novas: 8, quentes: 3, passagens: {Cleudo: 1, Agna: 2}, abertas: 4}),
    '8 conversas novas · 3 leads quentes · passagens: Agna 2, Cleudo 1 · 4 atendimentos em aberto');
  assert.equal(textoDoRelatorio({novas: 1, quentes: 1, passagens: {}, abertas: 1}),
    '1 conversa nova · 1 lead quente · nenhuma passagem para a equipe · 1 atendimento em aberto');
  assert.doesNotMatch(textoDoRelatorio({passagens: {'A\nB': 1}}), /\n/);
  const e = envioDoRelatorio('Agna', {novas: 2});
  assert.equal(e.template.name, RELATORIO_MODELO.name);
  assert.deepEqual(e.template.language, {code: 'pt_BR'});
  assert.equal(e.template.components[0].parameters[0].text, 'Agna');
  assert.equal((RELATORIO_TEXTO.match(/\{\{\d\}\}/g) || []).length, 2);
});
