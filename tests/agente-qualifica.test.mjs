import test from 'node:test';
import assert from 'node:assert/strict';
import {ferramentaPara, lerSugestao, montarPedido, criteriosDoAgente, FERRAMENTA, TEMPERATURAS} from '../lib/agente.mjs';

const CRIT = ['Necessidade identificada', 'Orçamento disponível', 'Poder de decisão', 'Prazo definido'];
const BASE = {enabled: true, name: 'Assistente', tone: 'descontraido', knowledge: 'x'.repeat(40), handoff: ''};
const agora = new Date('2026-11-24T15:00:00Z');

test('qualificação: sem critérios nada muda (mantém o cache); com critérios a ferramenta ganha os campos', () => {
  assert.equal(ferramentaPara([], []), FERRAMENTA);
  const f = ferramentaPara([], CRIT);
  assert.deepEqual(f.input_schema.properties.criterios.items.enum, CRIT);
  assert.deepEqual(f.input_schema.properties.temperatura.enum, TEMPERATURAS);
  assert.ok(!f.input_schema.required.includes('criterios')); // opcional
  const g = ferramentaPara(['Em contato'], CRIT);
  assert.ok(g.input_schema.properties.etapa && g.input_schema.properties.criterios);
  assert.deepEqual(criteriosDoAgente(['  A ', '', 3, 'B', 'C', 'D', 'E']), ['A', 'B', 'C', 'D']);
  assert.deepEqual(criteriosDoAgente(null), []);
});

test('qualificação: o pedido explica critérios e temperatura só quando a empresa tem critérios', () => {
  const sem = montarPedido({empresa: 'R', nicho: 'Motos', agente: BASE, contato: '', mensagens: [], agora, automatico: true});
  const com = montarPedido({empresa: 'R', nicho: 'Motos', agente: BASE, contato: '', mensagens: [], agora, automatico: true, criterios: CRIT});
  assert.doesNotMatch(sem.sistema, /Qualificação do lead/);
  assert.match(com.sistema, /Qualificação do lead/);
  assert.match(com.sistema, /"Orçamento disponível"/);
  assert.match(com.sistema, /quente = intenção de compra/);
  assert.equal(sem.usuario, com.usuario); // a parte que muda a cada mensagem é a mesma
});

test('qualificação: leitura só aceita critérios da empresa e temperatura válida', () => {
  const s = lerSugestao({resposta: 'Oi', criterios: ['Prazo definido', 'Inventado', 'Prazo definido', 7], temperatura: 'morno'}, [], CRIT);
  assert.deepEqual(s.criterios, ['Prazo definido']);
  assert.equal(s.temperatura, 'morno');
  const t = lerSugestao({resposta: 'Oi', criterios: ['Prazo definido'], temperatura: 'fervendo'}, [], CRIT);
  assert.equal('temperatura' in t, false);
  const u = lerSugestao({resposta: 'Oi', criterios: ['Prazo definido'], temperatura: 'quente'}, [], []); // empresa sem critérios
  assert.equal('criterios' in u || 'temperatura' in u, false);
});
