import test from 'node:test';
import assert from 'node:assert/strict';
import {lerTudo} from '../lib/paginar.mjs';

// Simula o Supabase: devolve no máximo 1.000 linhas por consulta, como o PostgREST.
const banco = n => {
  const linhas = Array.from({length: n}, (_, i) => ({id: i}));
  const chamadas = [];
  const montar = async (de, ate) => { chamadas.push([de, ate]); return {data: linhas.slice(de, Math.min(ate + 1, de + 1000)), error: null}; };
  return {montar, chamadas};
};

test('lê além de 1.000 linhas (1.104 contatos, como a Regtech)', async () => {
  const {montar, chamadas} = banco(1104);
  const tudo = await lerTudo(montar, {max: 20000});
  assert.equal(tudo.length, 1104);
  assert.equal(tudo.at(-1).id, 1103);
  assert.deepEqual(chamadas, [[0, 999], [1000, 1999]]);
});

test('para na primeira página incompleta e respeita o máximo', async () => {
  assert.equal((await lerTudo(banco(10).montar)).length, 10);
  assert.equal((await lerTudo(banco(0).montar)).length, 0);
  const {montar, chamadas} = banco(5000);
  assert.equal((await lerTudo(montar, {max: 2500})).length, 2500);
  assert.deepEqual(chamadas.at(-1), [2000, 2499]);
});

test('erro do banco sobe', async () => {
  await assert.rejects(lerTudo(async () => ({data: null, error: new Error('x')})), /x/);
});
