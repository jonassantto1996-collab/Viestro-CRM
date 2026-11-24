import test from 'node:test';
import assert from 'node:assert/strict';
import {fotosValidas, modelosComFoto, fotosParaEnviar, fotosJaEnviadas, legendaDaFoto} from '../lib/fotos-agente.mjs';
import {agenteValido} from '../lib/agente.mjs';

const U = 'https://exemplo.invalid/storage/v1/object/public/product-images/';
const agente = {photos: {'ZUB L70': U + 'a.png', 'Bot Flash': U + 'b.png', 'Yala TTX': U + 'c.png'}};

test('catálogo de fotos: opcional, só https, nome curto, até 40', () => {
  assert.equal(fotosValidas(undefined), true);
  assert.equal(fotosValidas(agente.photos), true);
  assert.equal(fotosValidas({'X': 'http://inseguro.invalid/a.png'}), false);
  assert.equal(fotosValidas({'X': 'javascript:alert(1)'}), false);
  assert.equal(fotosValidas({'': U + 'a.png'}), false);
  assert.equal(fotosValidas(['a']), false);
  assert.equal(fotosValidas(Object.fromEntries(Array.from({length: 41}, (_, i) => ['M' + i, U + i + '.png']))), false);
  const base = {enabled: false, name: 'Assistente', tone: 'acolhedor', knowledge: '', handoff: ''};
  assert.equal(agenteValido({...base, photos: agente.photos}), true);
  assert.equal(agenteValido({...base, photos: {'X': 'http://a.invalid/x.png'}}), false);
  assert.deepEqual(modelosComFoto(agente), ['ZUB L70', 'Bot Flash', 'Yala TTX']);
  assert.deepEqual(modelosComFoto({}), []);
});

test('fotos para enviar: só do catálogo, sem repetir, no máximo 2', () => {
  const r = fotosParaEnviar(['ZUB L70', 'Inventada', 'ZUB L70', 'Bot Flash', 'Yala TTX'], agente);
  assert.deepEqual(r.map(f => f.nome), ['ZUB L70', 'Bot Flash']);
  assert.equal(r[0].url, U + 'a.png');
  assert.equal(r[0].legenda, '📷 ZUB L70');
  assert.deepEqual(fotosParaEnviar(['ZUB L70', 'Yala TTX'], agente, ['ZUB L70']).map(f => f.nome), ['Yala TTX']);
  assert.deepEqual(fotosParaEnviar('ZUB L70', agente), []);
  assert.deepEqual(fotosParaEnviar(['ZUB L70'], {}), []);
});

test('fotos já enviadas: lidas pela legenda das imagens que a empresa mandou', () => {
  const msgs = [
    {direction: 'outbound', message_type: 'image', body: legendaDaFoto('ZUB L70')},
    {direction: 'outbound', message_type: 'image', body: 'foto qualquer da equipe'},
    {direction: 'inbound', message_type: 'image', body: '📷 Bot Flash'},
    {direction: 'outbound', message_type: 'text', body: '📷 Yala TTX'},
  ];
  assert.deepEqual(fotosJaEnviadas(msgs), ['ZUB L70']);
});

import {buildSendBody} from '../lib/whatsapp.mjs';
import {ferramentaPara, lerSugestao, montarPedido, FERRAMENTA} from '../lib/agente.mjs';

test('envio de imagem para a Meta: só link https, com legenda', () => {
  const b = buildSendBody('image', {image: {link: U + 'a.png', caption: '📷 ZUB L70'}}, '5594999990000');
  assert.deepEqual(b, {messaging_product: 'whatsapp', recipient_type: 'individual', to: '5594999990000', type: 'image', image: {link: U + 'a.png', caption: '📷 ZUB L70'}});
  assert.throws(() => buildSendBody('image', {image: {link: 'http://inseguro.invalid/a.png'}}, '5594999990000'));
  assert.throws(() => buildSendBody('image', {}, '5594999990000'));
});

test('agente: campo de fotos e regra só quando a empresa tem catálogo', () => {
  assert.equal(ferramentaPara([], [], []), FERRAMENTA);
  const f = ferramentaPara([], [], ['ZUB L70', 'Bot Flash']);
  assert.deepEqual(f.input_schema.properties.fotos.items.enum, ['ZUB L70', 'Bot Flash']);
  assert.equal(f.input_schema.properties.fotos.maxItems, 2);
  const base = {enabled: true, name: 'A', tone: 'acolhedor', knowledge: 'x'.repeat(40), handoff: ''};
  const agora = new Date('2026-11-24T15:00:00Z');
  const sem = montarPedido({empresa: 'R', nicho: 'Motos', agente: base, contato: '', mensagens: [], agora, automatico: true});
  const com = montarPedido({empresa: 'R', nicho: 'Motos', agente: base, contato: '', mensagens: [], agora, automatico: true, fotos: ['ZUB L70']});
  assert.doesNotMatch(sem.sistema, /Fotos: você pode mandar/);
  assert.match(com.sistema, /Fotos: você pode mandar a foto principal destes modelos.*ZUB L70/);
  assert.match(com.sistema, /Nunca diga que mandou foto se não marcou/);
  const s = lerSugestao({resposta: 'Olha ela 👇', fotos: ['ZUB L70', 'Inventada', 'ZUB L70', 'Bot Flash', 'Yala TTX']}, [], [], ['ZUB L70', 'Bot Flash', 'Yala TTX']);
  assert.deepEqual(s.fotos, ['ZUB L70', 'Bot Flash']);
  assert.equal('fotos' in lerSugestao({resposta: 'Oi', fotos: ['ZUB L70']}, [], [], []), false);
});
