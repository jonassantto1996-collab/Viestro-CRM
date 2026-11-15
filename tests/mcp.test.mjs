import test from 'node:test';
import assert from 'node:assert/strict';
import {chaveConector, conferirChave} from '../lib/mcp-chave.mjs';
import {responder, responderCorpo, ErroFerramenta, VERSOES} from '../lib/mcp-protocolo.mjs';

const SEGREDO = 'segredo-de-teste-com-mais-de-vinte-caracteres';
const EMPRESA = '0b877323-6f68-4a11-b2c2-435a6e001b9c';
const OUTRA = '11111111-2222-4333-8444-555555555555';

test('chave do conector confere só para a empresa e o segredo certos', () => {
  const chave = chaveConector(SEGREDO, EMPRESA);
  assert.equal(conferirChave(SEGREDO, chave), EMPRESA);
  assert.equal(conferirChave('outro-segredo-qualquer-com-tamanho-bom', chave), null);
  // trocar a empresa no endereço não abre os dados de outra empresa
  assert.equal(conferirChave(SEGREDO, OUTRA + chave.slice(36)), null);
  assert.equal(conferirChave(SEGREDO, chave.slice(0, -1) + (chave.at(-1) === 'A' ? 'B' : 'A')), null);
  assert.equal(conferirChave(SEGREDO, 'qualquer-coisa'), null);
  assert.equal(conferirChave(SEGREDO, ''), null);
  assert.equal(conferirChave('', chave), null);
});

test('rotação invalida endereços antigos', () => {
  const antiga = chaveConector(SEGREDO, EMPRESA);
  assert.equal(conferirChave(SEGREDO, antiga, 'nova'), null);
  assert.equal(conferirChave(SEGREDO, chaveConector(SEGREDO, EMPRESA, 'nova'), 'nova'), EMPRESA);
});

const ferramentas = [
  {name: 'eco', title: 'Eco', description: 'devolve', inputSchema: {type: 'object'}, run: async a => ({recebi: a})},
  {name: 'falha', title: 'Falha', description: 'erro amigável', inputSchema: {type: 'object'}, run: async () => { throw new ErroFerramenta('Diga qual lead.'); }},
  {name: 'quebra', title: 'Quebra', description: 'erro interno', inputSchema: {type: 'object'}, run: async () => { throw new Error('senha do banco xyz'); }},
];
const op = {ferramentas, servidor: {name: 't', version: '1'}, instrucoes: 'x'};

test('initialize negocia a versão do protocolo', async () => {
  const r = await responder({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26'}}, op);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, {tools: {listChanged: false}});
  const r2 = await responder({jsonrpc: '2.0', id: 2, method: 'initialize', params: {protocolVersion: '1999-01-01'}}, op);
  assert.equal(r2.result.protocolVersion, VERSOES[0]);
});

test('notificação não tem resposta; lote só de notificações também não', async () => {
  assert.equal(await responder({jsonrpc: '2.0', method: 'notifications/initialized'}, op), null);
  assert.equal(await responderCorpo([{jsonrpc: '2.0', method: 'notifications/initialized'}], op), null);
});

test('tools/list marca todas as ferramentas como só leitura', async () => {
  const r = await responder({jsonrpc: '2.0', id: 3, method: 'tools/list'}, op);
  assert.equal(r.result.tools.length, 3);
  assert.ok(r.result.tools.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));
  assert.ok(r.result.tools.every(t => !('run' in t)));
});

test('tools/call devolve texto; erro interno não vaza detalhes', async () => {
  const ok = await responder({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'eco', arguments: {a: 1}}}, op);
  assert.equal(ok.result.isError, false);
  assert.deepEqual(JSON.parse(ok.result.content[0].text), {recebi: {a: 1}});
  const amigavel = await responder({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'falha'}}, op);
  assert.equal(amigavel.result.isError, true);
  assert.equal(amigavel.result.content[0].text, 'Diga qual lead.');
  const interno = await responder({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'quebra'}}, op);
  assert.equal(interno.result.isError, true);
  assert.ok(!interno.result.content[0].text.includes('senha'));
});

test('ferramenta desconhecida, argumentos inválidos e método desconhecido viram erro JSON-RPC', async () => {
  assert.equal((await responder({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'apagar_tudo'}}, op)).error.code, -32602);
  assert.equal((await responder({jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'eco', arguments: [1]}}, op)).error.code, -32602);
  assert.equal((await responder({jsonrpc: '2.0', id: 9, method: 'resources/list'}, op)).error.code, -32601);
  assert.equal((await responder({id: 10, method: 'ping'}, op)).error.code, -32600);
  assert.deepEqual((await responder({jsonrpc: '2.0', id: 11, method: 'ping'}, op)).result, {});
});
