import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWhatsApp, messageContent, keyMatches, graphBase, buildSendBody, classifyGraphResponse, classifyNetworkError, unixToIso} from '../lib/whatsapp.mjs';

const wrap = (value, field = 'messages') => ({object: 'whatsapp_business_account', entry: [{id: 'WABA', changes: [{field, value: {messaging_product: 'whatsapp', metadata: {display_phone_number: '559491112222', phone_number_id: '111000111'}, ...value}}]}]});

test('mensagem recebida vira evento com contato, nome, horário e chave por número', () => {
  const [e] = normalizeWhatsApp(wrap({contacts: [{wa_id: '5594988887777', profile: {name: 'Maria'}}], messages: [{from: '5594988887777', id: 'wamid.A', timestamp: '1792760400', type: 'text', text: {body: 'Quero banho e tosa'}}]}));
  assert.equal(e.type, 'message');
  assert.equal(e.key, '111000111:msg:wamid.A');
  assert.equal(e.phone_number_id, '111000111');
  assert.deepEqual(e.payload, {wa_id: '5594988887777', name: 'Maria', wamid: 'wamid.A', ts: unixToIso('1792760400'), type: 'text', body: 'Quero banho e tosa', media_id: undefined});
});

test('mídia guarda só o id e a legenda, nunca o arquivo', () => {
  assert.deepEqual(messageContent({type: 'image', image: {id: 'MEDIA1', caption: 'Foto do Rex'}}), {type: 'image', body: 'Foto do Rex', media_id: 'MEDIA1'});
  assert.equal(messageContent({type: 'audio', audio: {id: 'M2'}}).body, '[Áudio]');
  assert.equal(messageContent({type: 'interactive', interactive: {button_reply: {title: 'Agendar'}}}).body, 'Agendar');
  assert.equal(messageContent({type: 'reaction', reaction: {emoji: '👍'}}).body, '[Reação 👍]');
  assert.equal(messageContent({type: 'novo_tipo'}).body, '[Mensagem do tipo novo_tipo]');
});

test('status de entrega gera eventos distintos por status, com código de erro', () => {
  const ev = normalizeWhatsApp(wrap({statuses: [{id: 'wamid.S', status: 'delivered', timestamp: '1'}, {id: 'wamid.S', status: 'failed', errors: [{code: 131047}]}]}));
  assert.deepEqual(ev.map(e => e.key), ['111000111:st:wamid.S:delivered', '111000111:st:wamid.S:failed']);
  assert.equal(ev[1].payload.error_code, '131047');
});

test('eco do app (resposta humana pelo celular) usa o destinatário como contato', () => {
  const [e] = normalizeWhatsApp(wrap({message_echoes: [{from: '559491112222', to: '5594988887777', id: 'wamid.E', timestamp: '2', type: 'text', text: {body: 'Temos horário!'}}]}, 'smb_message_echoes'));
  assert.equal(e.type, 'echo');
  assert.equal(e.payload.wa_id, '5594988887777');
  assert.equal(e.payload.body, 'Temos horário!');
});

test('histórico separa mensagens do cliente e da empresa', () => {
  const ev = normalizeWhatsApp(wrap({history: [{metadata: {phase: 0, progress: 100}, threads: [{id: '5594977776666', messages: [
    {from: '5594977776666', id: 'wamid.H1', timestamp: '3', type: 'text', text: {body: 'oi'}, history_context: {status: 'READ'}},
    {from: '559491112222', to: '5594977776666', id: 'wamid.H2', timestamp: '4', type: 'text', text: {body: 'olá'}, history_context: {status: 'DELIVERED'}},
  ]}]}]}, 'history'));
  assert.deepEqual(ev.map(e => [e.type, e.payload.direction, e.payload.wa_id, e.payload.status]), [
    ['history', 'inbound', '5594977776666', 'read'], ['history', 'outbound', '5594977776666', 'delivered']]);
});

test('histórico recusado pela empresa (erro 2593109) não gera eventos', () => {
  assert.deepEqual(normalizeWhatsApp(wrap({history: [{errors: [{code: 2593109}]}]}, 'history')), []);
});

test('agenda do app vira contacts_sync só com telefone e nome', () => {
  const [e] = normalizeWhatsApp(wrap({state_sync: [{type: 'contact', contact: {full_name: 'João do Rex', phone_number: '+55 94 97777-6666'}, action: 'add', metadata: {timestamp: '5'}}]}, 'smb_app_state_sync'));
  assert.deepEqual(e.payload, {wa_id: '5594977776666', name: 'João do Rex', action: 'add'});
});

test('ignora payloads de outros produtos, sem número ou malformados', () => {
  assert.deepEqual(normalizeWhatsApp({object: 'instagram', entry: []}), []);
  assert.deepEqual(normalizeWhatsApp({object: 'whatsapp_business_account', entry: [{changes: [{value: {messages: [{id: 'x', from: '1'}]}}]}]}), []);
  assert.deepEqual(normalizeWhatsApp(null), []);
  assert.deepEqual(normalizeWhatsApp(wrap({messages: [{id: 'sem-remetente'}]})), []);
});

test('chave da URL: exige 32+ caracteres configurados e compara exatamente', () => {
  const secret = 'k'.repeat(40);
  assert.equal(keyMatches(secret, secret), true);
  assert.equal(keyMatches(secret + 'x', secret), false);
  assert.equal(keyMatches('', secret), false);
  assert.equal(keyMatches('curta', 'curta'), false);
  assert.equal(keyMatches(secret, undefined), false);
});

test('token só vai para a API oficial da Meta', () => {
  assert.equal(graphBase(undefined), 'https://graph.facebook.com/v26.0');
  assert.equal(graphBase('https://graph.facebook.com/v25.0/'), 'https://graph.facebook.com/v25.0');
  assert.throws(() => graphBase('https://atacante.example/v26.0'));
  assert.throws(() => graphBase('http://graph.facebook.com/v26.0'));
});

test('corpo de envio de texto e template no formato da Cloud API', () => {
  assert.deepEqual(buildSendBody('text', {text: 'Oi'}, '+55 94 98888-7777'), {messaging_product: 'whatsapp', recipient_type: 'individual', to: '5594988887777', type: 'text', text: {body: 'Oi', preview_url: false}});
  const t = {name: 'lembrete', language: {code: 'pt_BR'}};
  assert.deepEqual(buildSendBody('template', {template: t}, '5594988887777').template, t);
  assert.throws(() => buildSendBody('outro', {}, '1'));
});

test('classificação de respostas: sucesso, limite (repete) e erro definitivo', () => {
  assert.deepEqual(classifyGraphResponse(200, {messages: [{id: 'wamid.OK'}]}), {ok: true, wamid: 'wamid.OK'});
  assert.deepEqual(classifyGraphResponse(400, {error: {code: 130429}}), {ok: false, code: '130429', retryable: true});
  assert.deepEqual(classifyGraphResponse(429, {}), {ok: false, code: 'http_429', retryable: true});
  assert.deepEqual(classifyGraphResponse(400, {error: {code: 131047}}), {ok: false, code: '131047', retryable: false});
  assert.deepEqual(classifyGraphResponse(401, {error: {code: 190}}), {ok: false, code: '190', retryable: false});
  assert.equal(classifyGraphResponse(200, {}).ok, false);
});

test('falha de rede: só repete se a conexão nunca abriu (evita mensagem duplicada)', () => {
  assert.equal(classifyNetworkError({cause: {code: 'ENOTFOUND'}}).retryable, true);
  assert.equal(classifyNetworkError({cause: {code: 'ECONNREFUSED'}}).retryable, true);
  assert.deepEqual(classifyNetworkError({name: 'TimeoutError'}), {ok: false, code: 'unknown_result', retryable: false});
  assert.equal(classifyNetworkError({cause: {code: 'ECONNRESET'}}).retryable, false);
});
