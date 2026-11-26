import test from 'node:test';
import assert from 'node:assert/strict';
import {remarketingValido, lerRemarketing, REMARKETING_PADRAO, MODELOS_REMARKETING, linhaDoRemarketing, linhasDaPlanilha, COLUNAS_PLANILHA} from '../lib/remarketing.mjs';
import {textoDoRelatorio, modelosDaEquipe} from '../lib/relatorio-diario.mjs';
import {corpoDoModelo} from '../lib/wasapflow.mjs';

test('configuração: desligado por padrão, 10 dias, 3 tentativas, 50 por número, seg-sáb 9h-18h', () => {
  assert.deepEqual(REMARKETING_PADRAO, {enabled: false, days: 10, max_attempts: 3, daily_limit: 50, send_days: 'seg-sab', start: '09:00', end: '18:00'});
  assert.deepEqual(lerRemarketing({}), REMARKETING_PADRAO);
  assert.equal(lerRemarketing({remarketing: {enabled: true}}).enabled, true);
  assert.equal(lerRemarketing({remarketing: {enabled: 'sim'}}).enabled, false); // inválido volta ao padrão (desligado)
});

test('configuração: valida faixas e horário', () => {
  assert.equal(remarketingValido(undefined), true);
  assert.equal(remarketingValido({enabled: true}), true);
  assert.equal(remarketingValido({...REMARKETING_PADRAO, enabled: true}), true);
  for (const ruim of [{enabled: 1}, {enabled: true, days: 0}, {enabled: true, days: 91}, {enabled: true, days: 10.5},
    {enabled: true, max_attempts: 4}, {enabled: true, daily_limit: 0}, {enabled: true, daily_limit: 1001},
    {enabled: true, send_days: 'dom'}, {enabled: true, start: '9h'}, {enabled: true, start: '18:00', end: '09:00'},
    {enabled: true, templates: []}, {enabled: true, templates: ['A B']}, [], 'x']) {
    assert.equal(remarketingValido(ruim), false, JSON.stringify(ruim));
  }
});

test('três modelos MARKETING pt_BR, um por tentativa, com {{1}} e saída por SAIR', () => {
  assert.deepEqual(MODELOS_REMARKETING.map(m => m.name), ['remarketing_parcela', 'remarketing_economia', 'remarketing_ultima']);
  for (const m of MODELOS_REMARKETING) {
    assert.equal(m.category, 'MARKETING');
    assert.equal(m.language, 'pt_BR');
    assert.equal((m.text.match(/\{\{\d\}\}/g) || []).length, 1);
    assert.match(m.text, /SAIR/);
    const corpo = corpoDoModelo(m);
    assert.equal(corpo.category, 'MARKETING');
    assert.deepEqual(corpo.components[0].example.body_text, [['João']]);
  }
  assert.match(MODELOS_REMARKETING[0].text, /12x ou 4x sem juros/);
  // Entram no botão "Criar modelos da equipe" junto com os da equipe (que continuam UTILITY)
  const todos = modelosDaEquipe();
  assert.deepEqual(todos.map(m => m.name), ['alerta_atendimento', 'relatorio_diario', 'remarketing_parcela', 'remarketing_economia', 'remarketing_ultima']);
  assert.equal(corpoDoModelo(todos[0]).category, 'UTILITY');
});

test('relatório diário: linha do remarketing só quando a empresa usa', () => {
  assert.equal(linhaDoRemarketing({enviados: 12, responderam: 3}), 'remarketing: 12 enviados, 3 responderam');
  assert.equal(linhaDoRemarketing({enviados: 1, responderam: 1}), 'remarketing: 1 enviado, 1 respondeu');
  assert.equal(linhaDoRemarketing(null), '');
  assert.match(textoDoRelatorio({novas: 2, remarketing: {enviados: 40, responderam: 5}}), / · remarketing: 40 enviados, 5 responderam$/);
  assert.doesNotMatch(textoDoRelatorio({novas: 2}), /remarketing/);
});

test('planilha do painel: uma linha por envio, com número, modelo, resultado e resposta', () => {
  const linhas = linhasDaPlanilha([{created_at: '2026-11-26T13:00:00Z', attempt: 2, template_name: 'remarketing_economia', outcome: 'responded',
    responded_at: '2026-11-26T15:30:00Z', lead: {nome: 'Maria'}, account: {phone_e164: '+5594992086088'}, message: {message_status: 'read', error_code: null}}]);
  assert.equal(COLUNAS_PLANILHA.length, linhas[0].length);
  assert.deepEqual(linhas[0].slice(1), ['Maria', '+5594992086088', 2, 'remarketing_economia', 'Lido', '', 'Respondeu', '26/11/2026, 12:30:00']);
  assert.equal(linhasDaPlanilha([{outcome: 'opt_out', message: {message_status: 'failed', error_code: 'meta_131049'}}])[0][7], 'Pediu para sair');
  assert.deepEqual(linhasDaPlanilha(null), []);
});
