import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizarTelefone, telefoneValido, telefonesValidos, telefoneDoAtendente, textoDoAlerta, envioDoAlerta, deveAvisar, ehAtendente, ALERTA_MODELO, ALERTA_TEXTO} from '../lib/alerta-atendente.mjs';
import {agenteValido} from '../lib/agente.mjs';

test('telefone: só dígitos, número brasileiro sem DDI ganha 55', () => {
  assert.equal(normalizarTelefone('95984401730'), '5595984401730');
  assert.equal(normalizarTelefone('(95) 98440-1730'), '5595984401730');
  assert.equal(normalizarTelefone('+55 95 98440-1730'), '5595984401730');
  assert.equal(normalizarTelefone('9440-1730'), '94401730'); // curto demais: fica inválido
  assert.equal(normalizarTelefone(''), '');
  assert.equal(telefoneValido('5595984401730'), true);
  assert.equal(telefoneValido('94401730'), false);
  assert.equal(telefoneValido('05595984401730'), false);
});

test('configuração: telefones dos atendentes são opcionais e validados', () => {
  const base = {enabled: false, name: 'Assistente', tone: 'acolhedor', knowledge: '', handoff: '', attendants: ['Agna']};
  assert.equal(agenteValido(base), true);
  assert.equal(agenteValido({...base, attendant_phones: {Agna: '5595984401730'}}), true);
  assert.equal(agenteValido({...base, attendant_phones: {Agna: '95984401730x'}}), false);
  assert.equal(agenteValido({...base, attendant_phones: ['5595984401730']}), false);
  assert.equal(telefonesValidos({}), true);
  assert.equal(telefonesValidos({'': '5595984401730'}), false);
  assert.equal(telefoneDoAtendente({attendant_phones: {Agna: '5595984401730'}}, 'Agna'), '5595984401730');
  assert.equal(telefoneDoAtendente({attendant_phones: {Agna: '5595984401730'}}, 'Equipe'), null);
  assert.equal(telefoneDoAtendente({}, 'Agna'), null);
});

test('alerta: texto limpo para a Meta, com 🔥 no quente', () => {
  assert.deepEqual(textoDoAlerta({atendente: 'Agna', cliente: 'João', motivo: 'Perguntou a parcela', quente: true}),
    {nome: 'Agna', detalhe: '🔥 Lead quente — João (Perguntou a parcela)'});
  assert.deepEqual(textoDoAlerta({atendente: 'Agna', cliente: '', motivo: ''}), {nome: 'Agna', detalhe: 'cliente do WhatsApp'});
  const sujo = textoDoAlerta({atendente: 'Agna', cliente: 'Ana\n\tMaria', motivo: 'linha1\nlinha2      fim'});
  assert.doesNotMatch(sujo.detalhe, /[\n\t]| {2,}/);
  const e = envioDoAlerta({atendente: 'Agna', cliente: 'João', quente: false});
  assert.equal(e.template.name, ALERTA_MODELO.name);
  assert.equal(e.template.language.code, 'pt_BR');
  assert.deepEqual(e.template.components[0].parameters.map(p => p.text), ['Agna', 'João']);
  assert.equal((ALERTA_TEXTO.match(/\{\{\d\}\}/g) || []).length, 2); // o modelo tem as 2 variáveis que enviamos
});

test('alerta: avisa na passagem nova e quando esquenta; não repete', () => {
  assert.equal(deveAvisar({antes: null, quente: false}), true);
  assert.equal(deveAvisar({antes: null, quente: true}), true);
  assert.equal(deveAvisar({antes: {hot: false}, quente: false}), false);
  assert.equal(deveAvisar({antes: {hot: false}, quente: true}), true);
  assert.equal(deveAvisar({antes: {hot: true}, quente: true}), false);
});

test('conversa do atendente: o agente não responde', () => {
  const agente = {attendant_phones: {Agna: '5595984401730'}};
  assert.equal(ehAtendente(agente, '5595984401730'), true);
  assert.equal(ehAtendente(agente, '5594999990000'), false);
  assert.equal(ehAtendente({}, '5595984401730'), false);
});

import {finalDoNumero, clienteComFinal} from '../lib/alerta-atendente.mjs';

test('final do número: últimos 4 dígitos para o atendente achar o cliente', () => {
  assert.equal(finalDoNumero('5594981115653'), '5653');
  assert.equal(finalDoNumero('+55 (94) 98111-5653'), '5653');
  assert.equal(finalDoNumero('123'), '');
  assert.equal(finalDoNumero(null), '');
  assert.equal(clienteComFinal('João', '5594981115653'), 'João (final 5653)');
  assert.equal(clienteComFinal('', '5594981115653'), 'cliente do WhatsApp final 5653');
  assert.equal(clienteComFinal('João', null), 'João');
});
