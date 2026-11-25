import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {
  assinaturaValida, chaveDoCaminho, normalizeWasapflow, pedidoDeEnvio, classificarResposta, classificarErroDeRede,
  avisoDoErro, chaveDoEnvio, modelosDaResposta, corpoDoModelo, telefoneDoCliente, deveRegistrar, numeroDaLista, linkDeConexao, AVISO, WF_BASE,
} from '../lib/wasapflow.mjs';
import {textoDoAviso, TEXTO_AVISO, AVISO_GRAVE} from '../lib/wasapflow-avisos.mjs';
import {modelosDaEquipe} from '../lib/relatorio-diario.mjs';

const SEGREDO = 'whs_teste_segredo_bem_comprido_123';
const assinar = corpo => 'sha256=' + createHmac('sha256', SEGREDO).update(corpo).digest('hex');
const env = (event, data, extra = {}) => ({event, waba_id: '111222333', phone_number_id: '444555666', timestamp: 1764000000, data, ...extra});

test('base fixa da ponte', () => {
  assert.equal(WF_BASE, 'https://officialapi.wasapflow.com/bridge/v1');
});

test('assinatura: HMAC-SHA256 do corpo bruto, formato sha256=<hex>', () => {
  const corpo = Buffer.from(JSON.stringify(env('message.received', {from: '5594999990000'})));
  assert.equal(assinaturaValida(corpo, assinar(corpo), SEGREDO), true);
  assert.equal(assinaturaValida(corpo.toString('utf8'), assinar(corpo), SEGREDO), true);
  // corpo alterado, outro segredo, sem prefixo, hex curto, segredo curto/ausente
  assert.equal(assinaturaValida(Buffer.from(corpo.toString() + ' '), assinar(corpo), SEGREDO), false);
  assert.equal(assinaturaValida(corpo, assinar(corpo), SEGREDO + 'x'), false);
  assert.equal(assinaturaValida(corpo, assinar(corpo).slice(7), SEGREDO), false);
  assert.equal(assinaturaValida(corpo, 'sha256=abc', SEGREDO), false);
  assert.equal(assinaturaValida(corpo, assinar(corpo), 'curto'), false);
  assert.equal(assinaturaValida(corpo, assinar(corpo), undefined), false);
  assert.equal(assinaturaValida(corpo, null, SEGREDO), false);
});

test('chave do caminho: derivada do segredo, estável e sem segredo = nenhuma', () => {
  const a = chaveDoCaminho(SEGREDO);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(chaveDoCaminho(SEGREDO), a);
  assert.notEqual(chaveDoCaminho(SEGREDO + '2'), a);
  assert.equal(chaveDoCaminho('curto'), null);
  assert.equal(chaveDoCaminho(undefined), null);
});

test('telefone do cliente: BSUID e texto nunca viram telefone', () => {
  assert.equal(telefoneDoCliente('5594999990000'), '5594999990000');
  assert.equal(telefoneDoCliente('+55 94 99999-0000'), '5594999990000');
  assert.equal(telefoneDoCliente('BR.2035200694071263'), null);
  assert.equal(telefoneDoCliente('US.ENT.11815799212886844830'), null);
  assert.equal(telefoneDoCliente('abc123'), null);
  assert.equal(telefoneDoCliente('123'), null);
  assert.equal(telefoneDoCliente(null), null);
});

test('message.received de texto vira "message" com a mesma chave do caminho antigo', () => {
  const n = normalizeWasapflow(env('message.received', {from: '5594999990000', bsuid: 'BR.1', message_id: 'wamid.A1', type: 'text',
    text: 'Quanto custa?', contact_name: 'João', timestamp: 1764000000, raw: {message: {id: 'wamid.A1', type: 'text', text: {body: 'Quanto custa?'}}}}));
  assert.equal(n.waba_id, '111222333');
  assert.deepEqual(n.events, [{type: 'message', key: '444555666:msg:wamid.A1', phone_number_id: '444555666',
    payload: {wa_id: '5594999990000', name: 'João', wamid: 'wamid.A1', ts: '2025-11-24T16:00:00.000Z', type: 'text', body: 'Quanto custa?', media_id: undefined}}]);
  assert.deepEqual(n.aviso, {clear: [AVISO.AGENTE_META]}); // mensagem normal: o agente da Meta não está mais atendendo
});

test('message.received de áudio e imagem trazem o id da mídia (raw.message)', () => {
  const audio = normalizeWasapflow(env('message.received', {from: '5594999990000', message_id: 'wamid.AU', type: 'audio', text: null,
    raw: {message: {type: 'audio', audio: {id: 'MEDIA123', mime_type: 'audio/ogg'}}}}));
  assert.equal(audio.events[0].payload.type, 'audio');
  assert.equal(audio.events[0].payload.media_id, 'MEDIA123');
  assert.equal(audio.events[0].payload.body, '[Áudio]');
  const img = normalizeWasapflow(env('message.received', {from: '5594999990000', message_id: 'wamid.IM', type: 'image',
    raw: {message: {type: 'image', image: {id: 'MEDIA9', caption: 'essa aqui'}}}}));
  assert.equal(img.events[0].payload.media_id, 'MEDIA9');
  assert.equal(img.events[0].payload.body, 'essa aqui');
  // Sem raw: usa os campos simples
  const simples = normalizeWasapflow(env('message.received', {from: '5594999990000', message_id: 'wamid.S', type: 'text', text: 'oi'}));
  assert.equal(simples.events[0].payload.body, 'oi');
});

test('mensagem só com BSUID (sem telefone) é descartada e contada', () => {
  const n = normalizeWasapflow(env('message.received', {from: null, bsuid: 'BR.99', message_id: 'wamid.B', type: 'text', text: 'oi'}));
  assert.equal(n.events.length, 0);
  assert.equal(n.semTelefone, 1);
});

test('message.echo (celular do atendente) vira "echo" de saída', () => {
  const n = normalizeWasapflow(env('message.echo', {direction: 'outbound', source: 'business_app', message_id: 'wamid.E', from: '5594992086088',
    recipient: '5594999990000', type: 'text', text: 'Bom dia, tudo bem?', raw: {echo: {type: 'text', text: {body: 'Bom dia, tudo bem?'}}}}));
  assert.equal(n.events[0].type, 'echo');
  assert.equal(n.events[0].key, '444555666:echo:wamid.E');
  assert.equal(n.events[0].payload.wa_id, '5594999990000');
  assert.equal(n.events[0].payload.body, 'Bom dia, tudo bem?');
});

test('message.history: direção, status e hora original; nunca vira "message"', () => {
  const n = normalizeWasapflow(env('message.history', {history: true, direction: 'outbound', status: 'read', thread_id: '5594999990000',
    contact_wa_id: '5594999990000', message_id: 'wamid.H', type: 'text', text: 'Pode vir sábado', timestamp: 1504902988}));
  assert.equal(n.events[0].type, 'history');
  assert.equal(n.events[0].payload.direction, 'outbound');
  assert.equal(n.events[0].payload.status, 'read');
  assert.equal(n.events[0].payload.ts, '2017-09-08T20:36:28.000Z');
  const entrada = normalizeWasapflow(env('message.history', {direction: 'inbound', contact_wa_id: '5594999990000', message_id: 'wamid.H2', type: 'media_placeholder'}));
  assert.equal(entrada.events[0].payload.direction, 'inbound');
  assert.equal(entrada.events[0].payload.status, undefined);
});

test('contact.synced vira agenda (add/update/remove)', () => {
  const n = normalizeWasapflow(env('contact.synced', {action: 'add', full_name: 'Maria Cliente', phone_number: '5594999990000', version: 3}));
  assert.deepEqual(n.events[0], {type: 'contacts_sync', key: '444555666:cs:5594999990000:3:add', phone_number_id: '444555666',
    payload: {wa_id: '5594999990000', name: 'Maria Cliente', action: 'add'}});
  assert.equal(normalizeWasapflow(env('contact.synced', {action: 'remove', phone_number: 'BR.1'})).events.length, 0);
});

test('status sent/delivered/read/failed com código de erro; chave por wamid+status', () => {
  for (const s of ['sent', 'delivered', 'read']) {
    const n = normalizeWasapflow(env(`message.${s}`, {message_id: 'wamid.X', status: s, recipient: '5594999990000', errors: null}));
    assert.deepEqual(n.events[0].payload, {wamid: 'wamid.X', status: s, ts: '2025-11-24T16:00:00.000Z', error_code: undefined});
    assert.equal(n.events[0].key, `444555666:st:wamid.X:${s}`);
  }
  const f = normalizeWasapflow(env('message.failed', {message_id: 'wamid.X', errors: [{code: 131047, title: 'Re-engagement'}]}));
  assert.equal(f.events[0].payload.status, 'failed');
  assert.equal(f.events[0].payload.error_code, '131047');
});

test('sem phone_number_id no envelope: chave usa o waba (o banco acha o número)', () => {
  const n = normalizeWasapflow({event: 'message.sent', waba_id: '111222333', data: {message_id: 'wamid.Z'}});
  assert.equal(n.phone_number_id, null);
  assert.equal(n.events[0].key, 'wf111222333:st:wamid.Z:sent');
});

test('modelos, conexão e agente da Meta viram ações, não mensagens', () => {
  assert.equal(normalizeWasapflow(env('template.status_updated', {template_name: 'alerta_atendimento', status: 'APPROVED'})).templates, true);
  assert.deepEqual(normalizeWasapflow(env('waba.offboarded', {})).aviso, {set: AVISO.DESCONECTADO});
  assert.deepEqual(normalizeWasapflow(env('waba.partner_removed', {})).aviso, {set: AVISO.REMOVIDO});
  assert.deepEqual(normalizeWasapflow(env('waba.reconnected', {})).aviso, {clear: [AVISO.DESCONECTADO, AVISO.REMOVIDO]});
  assert.deepEqual(normalizeWasapflow(env('waba.account_updated', {event: 'ACCOUNT_RESTRICTION'})).aviso, {set: AVISO.RESTRITO});
  assert.equal(normalizeWasapflow(env('waba.account_updated', {event: 'VERIFIED_ACCOUNT'})).aviso, null);
  const sb = normalizeWasapflow(env('standby.message_received', {standby: true, message_id: 'wamid.SB', from: '5594999990000', type: 'text', text: 'Tem saiz S?'}));
  assert.deepEqual(sb.aviso, {set: AVISO.AGENTE_META});
  assert.equal(sb.events[0].type, 'history'); // guardado só como contexto: o agente não responde
  assert.equal(normalizeWasapflow(env('evento.novo', {})).desconhecido, 'evento.novo');
  assert.equal(normalizeWasapflow({event: 'message.received', data: {}}).events.length, 0); // sem waba_id
});

test('registro de evento desconhecido: 1ª, 2ª, 4ª, 8ª...', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 9, 16].map(deveRegistrar), [true, true, false, true, false, true, false, true]);
});

test('pedido de envio: texto, modelo e imagem nas rotas da ponte', () => {
  assert.deepEqual(pedidoDeEnvio('text', {text: 'Oi'}, '+55 94 99999-0000', 'ref-1'),
    {path: '/messages/send', body: {to: '5594999990000', biz_opaque_callback_data: 'ref-1', text: 'Oi', preview_url: false}});
  const tpl = {name: 'alerta_atendimento', language: {code: 'pt_BR'}, components: []};
  assert.deepEqual(pedidoDeEnvio('template', {template: tpl}, '5594999990000'), {path: '/messages/template', body: {to: '5594999990000', template: tpl}});
  assert.deepEqual(pedidoDeEnvio('image', {image: {link: 'https://x.supabase.co/a.jpg', caption: '📷 X16'}}, '5594999990000'),
    {path: '/messages/media', body: {to: '5594999990000', type: 'image', media: {link: 'https://x.supabase.co/a.jpg', caption: '📷 X16'}}});
  assert.throws(() => pedidoDeEnvio('image', {image: {link: 'http://inseguro/a.jpg'}}, '5594999990000'));
  assert.throws(() => pedidoDeEnvio('audio', {}, '5594999990000'));
  assert.throws(() => pedidoDeEnvio('text', {text: 'x'}, 'BR.123'));
});

test('resposta da ponte: wamid em message_id ou messages[0].id', () => {
  assert.deepEqual(classificarResposta(200, {success: true, message_id: 'wamid.1'}), {ok: true, wamid: 'wamid.1'});
  assert.deepEqual(classificarResposta(201, {success: true, messages: [{id: 'wamid.2'}]}), {ok: true, wamid: 'wamid.2'});
  assert.equal(classificarResposta(200, {success: false, error: {code: 'X'}}).ok, false);
});

test('erros: pagamento e bloqueio viram aviso, não repetem; 429/5xx/em andamento repetem', () => {
  for (const code of ['PAYMENT_REQUIRED', 'PAYMENT_FAILED', 'TRIAL_EXPIRED', 'SUBSCRIPTION_CANCELLED', 'CARD_REQUIRED', 'PAYMENT_ACTION_REQUIRED']) {
    const r = classificarResposta(402, {success: false, error: {code}});
    assert.equal(r.retryable, false, code);
    assert.equal(r.aviso, AVISO.PAGAMENTO, code);
  }
  assert.equal(classificarResposta(403, {success: false, error: {code: 'SUBSCRIPTION_INACTIVE'}}).aviso, AVISO.PAGAMENTO);
  assert.equal(classificarResposta(403, {success: false, error: {code: 'PARTNER_SUSPENDED'}}).aviso, AVISO.SUSPENSO);
  assert.equal(classificarResposta(401, {success: false, error: {code: 'INVALID_PARTNER_KEY'}}).aviso, AVISO.CHAVE);
  assert.equal(classificarResposta(404, {success: false, error: {code: 'WABA_NOT_REGISTERED'}}).aviso, AVISO.SEM_NUMERO);
  assert.equal(classificarResposta(429, {success: false, error: {code: 'RATE_LIMIT_EXCEEDED'}}).retryable, true);
  assert.equal(classificarResposta(409, {success: false, error: {code: 'IDEMPOTENCY_IN_PROGRESS'}}).retryable, true);
  assert.equal(classificarResposta(500, {success: false, error: {code: 'SERVER_ERROR'}}).retryable, true);
  assert.equal(classificarResposta(400, {success: false, error: {code: 'INVALID_FIELD'}}).retryable, false);
  // Erro da Meta: código da Meta no registro; repete só o que a Meta garante que não foi enviado
  const janela = classificarResposta(502, {success: false, error: {code: 'META_ERROR', meta_code: 131047}});
  assert.deepEqual(janela, {ok: false, code: 'meta_131047', retryable: false, aviso: null});
  assert.equal(classificarResposta(502, {success: false, error: {code: 'META_ERROR', meta_code: 130429}}).retryable, true);
  assert.equal(classificarResposta(500, {success: false, error: {code: 'META_ERROR'}}).retryable, false);
  assert.equal(classificarErroDeRede().retryable, true); // com a mesma Idempotency-Key não duplica
  assert.equal(avisoDoErro(402, 'QUALQUER'), AVISO.PAGAMENTO);
  assert.equal(avisoDoErro(400, 'INVALID_FIELD'), null);
});

test('chave de idempotência estável por item da fila', () => {
  assert.equal(chaveDoEnvio('abc'), 'viestro-outbox-abc');
  assert.equal(chaveDoEnvio('abc'), chaveDoEnvio('abc'));
});

test('GET /templates → linhas válidas para wa_templates', () => {
  const r = modelosDaResposta({success: true, templates: [
    {id: '1', name: 'alerta_atendimento', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED', components: [{type: 'BODY', text: 'Olá {{1}}'}]},
    {id: '2', name: 'Nome Inválido', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED'},
    {id: '3', name: 'x', language: 'pt_BR', category: 'OUTRA', status: 'APPROVED'},
  ]});
  assert.equal(r.length, 1);
  assert.equal(r[0].external_template_id, '1');
  assert.deepEqual(modelosDaResposta(null), []);
});

test('modelos da equipe: UTILITY, pt_BR, com exemplos e os mesmos textos do código', () => {
  const [alerta, relatorio] = modelosDaEquipe();
  assert.equal(alerta.name, 'alerta_atendimento');
  assert.equal(relatorio.name, 'relatorio_diario');
  for (const m of [alerta, relatorio]) {
    const corpo = corpoDoModelo(m);
    assert.equal(corpo.category, 'UTILITY');
    assert.equal(corpo.language, 'pt_BR');
    assert.equal(corpo.parameter_format, 'POSITIONAL');
    assert.equal(corpo.components[0].text, m.text);
    assert.equal((m.text.match(/\{\{\d\}\}/g) || []).length, corpo.components[0].example.body_text[0].length);
  }
});

test('conexão: número conferido em GET /clients e link só do WasapFlow', () => {
  const lista = {clients: [{waba_id: '111', phone_number_id: '222', phone_number: '+55 94 99208-6088', display_name: 'Regtech', status: 'active'}]};
  assert.deepEqual(numeroDaLista(lista, '111', '222'), {waba_id: '111', phone_number_id: '222', phone_e164: '+5594992086088', display_name: 'Regtech', status: 'active'});
  assert.equal(numeroDaLista(lista, '111', '999'), null);
  assert.equal(numeroDaLista({}, '111', '222'), null);
  assert.equal(linkDeConexao({connect_url: 'https://officialapi.wasapflow.com/bridge/connect?token=a'}), 'https://officialapi.wasapflow.com/bridge/connect?token=a');
  assert.equal(linkDeConexao({connect_url: 'https://outro.site/x'}), null);
});

test('avisos do número têm texto; pagamento é grave, agente da Meta não', () => {
  for (const c of Object.values(AVISO)) assert.ok(TEXTO_AVISO[c], c);
  assert.equal(AVISO_GRAVE.has(AVISO.PAGAMENTO), true);
  assert.equal(AVISO_GRAVE.has(AVISO.AGENTE_META), false);
  assert.match(textoDoAviso('desconhecido'), /fornecedor/);
});
