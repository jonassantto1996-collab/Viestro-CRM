import test from 'node:test';
import assert from 'node:assert/strict';
import {waMetrics} from '../lib/whatsapp-metrics.mjs';

const NOW = Date.parse('2026-10-25T15:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

test('tempo de resposta, resposta em até 1h e aguardando', () => {
  const conversations = [
    {id: 'a', status: 'open', category: 'Orçamento', assigned_user_id: 'u1', first_inbound_at: at(300), last_inbound_at: at(100), last_outbound_at: at(250), contact: {crm_lead_id: 'L1'}},
    {id: 'b', status: 'resolved', category: null, assigned_user_id: null, first_inbound_at: at(60 * 24 * 40), last_inbound_at: at(200), last_outbound_at: at(30), contact: {}},
  ];
  const messages = [
    {conversation_id: 'a', direction: 'inbound', source: 'api_inbound', at: at(300)},
    {conversation_id: 'a', direction: 'inbound', source: 'api_inbound', at: at(290)}, // segunda mensagem não reinicia a espera
    {conversation_id: 'a', direction: 'outbound', source: 'crm', at: at(250)},       // 50 min
    {conversation_id: 'a', direction: 'inbound', source: 'api_inbound', at: at(100)},  // aguardando
    {conversation_id: 'b', direction: 'inbound', source: 'api_inbound', at: at(200)},
    {conversation_id: 'b', direction: 'outbound', source: 'app_echo', at: at(30)},     // 170 min
  ];
  const m = waMetrics({conversations, messages, days: 7, now: NOW});
  assert.equal(m.conversations, 2);
  assert.equal(m.newConversations, 1);
  assert.equal(m.received, 4);
  assert.equal(m.sentCrm, 1);
  assert.equal(m.sentPhone, 1);
  assert.equal(m.responses, 2);
  assert.equal(m.avgResponseMs, 110 * 60_000);
  assert.equal(m.medianResponseMs, 110 * 60_000);
  assert.equal(m.within1hPct, 50);
  assert.equal(m.awaiting, 1);
  assert.equal(m.leads, 1);
  assert.deepEqual(m.byCategory.map(x => x.name).sort(), ['Orçamento', 'Sem tipo']);
  assert.equal(m.series.length, 7);
  assert.equal(m.series.at(-1).recebidas + m.series.at(-2).recebidas, 4);
});

test('mensagens fora do período não contam, mas a espera iniciada antes não vira amostra', () => {
  const conversations = [{id: 'x', status: 'open', first_inbound_at: at(60 * 24 * 10)}];
  const messages = [
    {conversation_id: 'x', direction: 'inbound', source: 'history_sync', at: at(60 * 24 * 10)},
    {conversation_id: 'x', direction: 'outbound', source: 'history_sync', at: at(60 * 24 * 5)},
  ];
  const m = waMetrics({conversations, messages, days: 7, now: NOW});
  assert.equal(m.received, 0);
  assert.equal(m.responses, 0);
  assert.equal(m.avgResponseMs, null);
  assert.equal(m.sentPhone, 1);
});
