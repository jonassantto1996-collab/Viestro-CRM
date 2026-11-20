import test from 'node:test';
import assert from 'node:assert/strict';
import {ehDono} from '../lib/dono.mjs';

test('dono da plataforma: só e-mails da lista, sem diferença de maiúsculas e espaços', () => {
  const lista = ' dono@example.invalid , outro@example.invalid';
  assert.equal(ehDono('dono@example.invalid', lista), true);
  assert.equal(ehDono('  DONO@Example.invalid ', lista), true);
  assert.equal(ehDono('outro@example.invalid', lista), true);
  assert.equal(ehDono('cliente@example.invalid', lista), false);
  assert.equal(ehDono('', lista), false);
  assert.equal(ehDono(null, lista), false);
  // Sem variável configurada: ninguém é dono (o conector fica escondido de todos)
  assert.equal(ehDono('dono@example.invalid', undefined), false);
  assert.equal(ehDono('dono@example.invalid', ''), false);
  assert.equal(ehDono('dono@example.invalid', ' , '), false);
});

import {manterModeloDoDono} from '../lib/dono.mjs';

test('cliente não troca o modelo de IA: volta o salvo, ou some se não havia', () => {
  const novas = {stages: ['A'], agent: {name: 'X', model: 'avancado'}};
  assert.equal(manterModeloDoDono(novas, {agent: {model: 'rapido'}}).agent.model, 'rapido');
  assert.equal('model' in manterModeloDoDono(novas, {agent: {}}).agent, false);
  assert.equal('model' in manterModeloDoDono(novas, null).agent, false);
  assert.equal(manterModeloDoDono({...novas, agent: {name: 'X'}}, {agent: {model: 'avancado'}}).agent.model, 'avancado');
  assert.deepEqual(manterModeloDoDono({stages: ['A']}, {agent: {model: 'avancado'}}), {stages: ['A']}); // sem agente: não mexe
  assert.equal(novas.agent.model, 'avancado'); // não altera o objeto original
});
