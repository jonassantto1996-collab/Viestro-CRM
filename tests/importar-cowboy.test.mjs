import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizarTelefone, etapaCowboy, linhasPorTitulo, confereColunas, montarImportacao, emLotes} from '../lib/importar-cowboy.mjs';

const ETAPAS = ['Novo Lead', 'Em contato', 'Em Negociação', 'Visita Agendada', 'CPF Negativado', 'Follow UP', 'Ganho', 'Perdido'];

test('telefone: acrescenta o 9 no celular, aceita 13 dígitos e recusa o resto', () => {
  assert.equal(normalizarTelefone(559491234567), '+5594991234567');
  assert.equal(normalizarTelefone('559491234567.0'), '+5594991234567');
  assert.equal(normalizarTelefone(5594991234567), '+5594991234567');
  assert.equal(normalizarTelefone('(94) 99123-4567'), '+5594991234567');
  assert.equal(normalizarTelefone('559433214567'), '+559433214567'); // fixo: sem 9
  assert.equal(normalizarTelefone('123'), '');
  assert.equal(normalizarTelefone(''), '');
  assert.equal(normalizarTelefone(null), '');
});

test('etapa: tira o emoji, ignora maiúsculas/acentos e troca Vendido por Ganho', () => {
  assert.equal(etapaCowboy('🟢 Em contato', ETAPAS), 'Em contato');
  assert.equal(etapaCowboy(' 🟢 Em Negociação ', ETAPAS), 'Em Negociação');
  assert.equal(etapaCowboy('em negociacao', ETAPAS), 'Em Negociação');
  assert.equal(etapaCowboy('❌ Perdido', ETAPAS), 'Perdido');
  assert.equal(etapaCowboy('🟢 Vendido', ETAPAS), 'Ganho');
  assert.equal(etapaCowboy('Follow UP', ETAPAS), 'Follow UP');
  assert.equal(etapaCowboy('Arquivado', ETAPAS), null);
  assert.equal(etapaCowboy('', ETAPAS), null);
});

test('planilha: títulos viram chaves, linhas vazias saem e colunas obrigatórias são conferidas', () => {
  const l = linhasPorTitulo([['Nome', 'Telefone'], ['Ana', 559491234567], [null, null]]);
  assert.deepEqual(l, [{Nome: 'Ana', Telefone: 559491234567}]);
  assert.deepEqual(confereColunas(l, [{Contato: 'Ana', Status: 'x'}]), []);
  assert.deepEqual(confereColunas([{Nome: 'Ana'}], [{Status: 'x'}]), ['Contatos: Telefone', 'Funil: Contato']);
});

test('importação: junta por nome, fica a oportunidade mais recente e separa os problemas', () => {
  const contatos = [
    {id: 'c1', 'Created At': '2026-10-21T10:00:00-03:00', Nome: 'Ana Souza', Telefone: 559491234567},
    {id: 'c2', 'Created At': '2026-10-22T10:00:00-03:00', Nome: 'Bruno', Telefone: null},
    {id: 'c3', Nome: 'Carla', Telefone: 559491111111},
    {id: 'c4', Nome: 'carla ', Telefone: 559492222222},
    {id: 'c5', Nome: 'Davi', Telefone: 559493333333},
    {id: 'c6', Nome: '', Telefone: 559494444444},
  ];
  const funil = [
    {id: 'f1', Assignee: 'David (Regtech) ', 'Created At': '2026-10-25T10:00:00-03:00', Status: '🟢 Em contato', Contato: 'ANA SOUZA', Prioridade: 'Alta', 'Observação': 'Cliente de remarketing'},
    {id: 'f2', Assignee: '-', 'Created At': '2026-11-02T10:00:00-03:00', Status: '🟢 Vendido', Contato: 'Ana Souza', Prioridade: '-', 'Observação': '-'},
    {id: 'f3', Assignee: '-', 'Created At': '2026-10-30T10:00:00-03:00', Status: 'Arquivado', Contato: 'Bruno', Prioridade: 'Baixa', 'Observação': '-'},
    {id: 'f4', Assignee: '-', Status: '❌ Perdido', Contato: 'Carla'},
    {id: 'f5', Assignee: '-', Status: '❌ Perdido', Contato: ''},
  ];
  const {leads, avisos, porEtapa} = montarImportacao(contatos, funil, ETAPAS);
  const ana = leads.find((l) => l.name === 'Ana Souza');
  assert.equal(ana.stage, 'Ganho');
  assert.equal(ana.phone, '+5594991234567');
  assert.equal(ana.importId, 'cowboy:f2');
  assert.equal(ana.owner, '');
  assert.equal(ana.notes, 'Importado do Cowboy');
  assert.match(ana.created, /^2026-11-02T13:00:00/);
  const bruno = leads.find((l) => l.name === 'Bruno');
  assert.equal(bruno.stage, 'Novo Lead');
  assert.equal(bruno.phone, '');
  assert.equal(bruno.notes, 'Prioridade: Baixa · Importado do Cowboy');
  const davi = leads.find((l) => l.name === 'Davi');
  assert.equal(davi.stage, 'Novo Lead');
  assert.equal(davi.importId, 'cowboy:c5');
  assert.equal(leads.some((l) => /carla/i.test(l.name)), false);
  assert.deepEqual(avisos.nomesRepetidos, ['Carla']);
  assert.equal(avisos.semNome, 2);
  assert.equal(avisos.semTelefone, 1);
  assert.deepEqual(avisos.etapasDesconhecidas, {Arquivado: 1});
  assert.equal(porEtapa['Ganho'], 1);
  assert.equal(porEtapa['Novo Lead'], 2);
  assert.equal(leads.length, 3);
});

test('responsável: tira o "(Regtech)" do nome', () => {
  const {leads} = montarImportacao([{Nome: 'Eva', Telefone: 559491234567}], [{Contato: 'Eva', Status: 'Novo Lead', Assignee: 'David (Regtech) '}], ETAPAS);
  assert.equal(leads[0].owner, 'David');
});

test('lotes: divide sem perder ninguém', () => {
  const l = Array.from({length: 450}, (_, i) => i);
  const lotes = emLotes(l, 200);
  assert.deepEqual(lotes.map((x) => x.length), [200, 200, 50]);
});
