import test from 'node:test';
import assert from 'node:assert/strict';
import {conversaSimulada, SIM_MAX_MENSAGENS} from '../lib/simulador.mjs';

const agora = new Date('2026-11-20T15:00:00Z');

test('simulador: monta a conversa no formato do agente, em ordem e terminando agora', () => {
  const m = conversaSimulada([
    {de: 'cliente', texto: ' Oi, quanto custa a Tanke? '},
    {de: 'empresa', texto: 'Oi! Um atendente já te passa os valores.'},
    {de: 'cliente', texto: 'Tá caro?'},
  ], agora);
  assert.deepEqual(m.map(x => x.direction), ['inbound', 'outbound', 'inbound']);
  assert.equal(m[0].body, 'Oi, quanto custa a Tanke?');
  assert.equal(m[2].at, agora.toISOString());
  assert.ok(m[0].at < m[1].at && m[1].at < m[2].at);
  assert.ok(m.every(x => x.message_type === 'text'));
});

test('simulador: recusa conversa inválida', () => {
  assert.equal(conversaSimulada([], agora), null);
  assert.equal(conversaSimulada(null, agora), null);
  assert.equal(conversaSimulada([{de: 'cliente', texto: '  '}], agora), null);
  assert.equal(conversaSimulada([{de: 'hacker', texto: 'oi'}], agora), null);
  assert.equal(conversaSimulada([{de: 'cliente', texto: 'x'.repeat(1501)}], agora), null);
  assert.equal(conversaSimulada([{de: 'cliente', texto: 'oi'}, {de: 'empresa', texto: 'olá'}], agora), null); // última precisa ser do cliente
  assert.equal(conversaSimulada(Array.from({length: SIM_MAX_MENSAGENS + 1}, () => ({de: 'cliente', texto: 'oi'})), agora), null);
});
