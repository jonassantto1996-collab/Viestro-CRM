import test from 'node:test';
import assert from 'node:assert/strict';
import {MODELOS, modeloDoAgente, chamadaDoAgente, agenteValido, FERRAMENTA} from '../lib/agente.mjs';

const base = {enabled: false, name: 'Assistente', tone: 'acolhedor', knowledge: '', handoff: ''};

test('modelo por empresa: rápido é o padrão; avançado só quando escolhido', () => {
  assert.equal(modeloDoAgente(base), MODELOS.rapido);
  assert.equal(modeloDoAgente({...base, model: 'rapido'}), MODELOS.rapido);
  assert.equal(modeloDoAgente({...base, model: 'avancado'}), MODELOS.avancado);
  assert.equal(modeloDoAgente(base, 'claude-haiku-4-5'), 'claude-haiku-4-5'); // CRM_AGENTE_MODELO troca o rápido
  assert.equal(modeloDoAgente({...base, model: 'avancado'}, 'claude-haiku-4-5'), MODELOS.avancado);
  assert.equal(agenteValido({...base, model: 'avancado'}), true);
  assert.equal(agenteValido({...base, model: 'opus'}), false);
});

test('chamada: Haiku com ferramenta obrigatória; Sonnet sem (o Sonnet 5.5 recusa) e com reserva em recusa', () => {
  const p = {sistema: 'S', usuario: 'U', ferramenta: FERRAMENTA};
  const h = chamadaDoAgente({...p, modelo: MODELOS.rapido});
  assert.equal(h.beta, null);
  assert.deepEqual(h.body.tool_choice, {type: 'tool', name: 'sugerir_resposta'});
  assert.equal(h.body.max_tokens, 700);
  assert.equal(h.body.system[0].cache_control.type, 'ephemeral');
  const s = chamadaDoAgente({...p, modelo: MODELOS.avancado});
  assert.equal(s.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(s.body.tool_choice, {type: 'auto'});
  assert.equal(s.body.output_config.effort, 'low');
  assert.equal(s.body.fallbacks, 'default');
  assert.equal(s.beta, 'server-side-fallback-2026-07-01');
  assert.ok(s.body.max_tokens >= 4000); // pensamento conta no limite
  assert.equal('temperature' in s.body, false);
});
