// Indicadores de atendimento do WhatsApp. Função pura: usada no servidor (dados reais)
// e na demonstração (dados fictícios). Horários agrupados no fuso de São Paulo.

const TZ = 'America/Sao_Paulo';
const dayKey = d => new Date(d).toLocaleDateString('en-CA', {timeZone: TZ});

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * @param {{conversations: any[], messages: {conversation_id:string, direction:string, source:string, at:string}[], days:number, now?:number}} input
 * Tempo de resposta: a cada mensagem do cliente sem resposta, conta até a próxima mensagem
 * enviada (pelo CRM ou pelo celular). Conversas importadas do histórico entram na conta.
 */
export function waMetrics({conversations, messages, days, now = Date.now()}) {
  const since = now - days * 86_400_000;
  const byConv = new Map();
  for (const m of messages) {
    const t = new Date(m.at).getTime();
    if (!Number.isFinite(t)) continue;
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id).push({...m, t});
  }

  const samples = [];
  const active = new Set();
  let received = 0, sentCrm = 0, sentPhone = 0;
  for (const [conv, list] of byConv) {
    list.sort((a, b) => a.t - b.t);
    let waitStart = null;
    for (const m of list) {
      if (m.direction === 'inbound') {
        if (m.t >= since) { received++; active.add(conv); }
        if (waitStart === null) waitStart = m.t;
      } else {
        if (m.t >= since) { if (m.source === 'crm') sentCrm++; else sentPhone++; }
        if (waitStart !== null) {
          if (waitStart >= since) samples.push(Math.max(0, m.t - waitStart));
          waitStart = null;
        }
      }
    }
  }

  const awaiting = conversations.filter(c => c.status !== 'resolved' && c.last_inbound_at
    && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at)).length;
  const fresh = conversations.filter(c => c.first_inbound_at && new Date(c.first_inbound_at).getTime() >= since).length;
  const activeConvs = conversations.filter(c => active.has(c.id));

  const chartDays = Math.min(days, 30);
  const series = Array.from({length: chartDays}, (_, i) => {
    const key = dayKey(now - (chartDays - 1 - i) * 86_400_000);
    return {key, label: key.slice(8, 10) + '/' + key.slice(5, 7), recebidas: 0, enviadas: 0};
  });
  const idx = new Map(series.map((s, i) => [s.key, i]));
  for (const list of byConv.values()) for (const m of list) {
    const i = idx.get(dayKey(m.t));
    if (i === undefined) continue;
    if (m.direction === 'inbound') series[i].recebidas++; else series[i].enviadas++;
  }

  const group = (keyOf) => {
    const out = new Map();
    for (const c of activeConvs) { const k = keyOf(c); out.set(k, (out.get(k) || 0) + 1); }
    return [...out.entries()].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count);
  };

  return {
    days,
    conversations: activeConvs.length,
    newConversations: fresh,
    received,
    sentCrm,
    sentPhone,
    awaiting,
    leads: conversations.filter(c => c.contact?.crm_lead_id).length,
    responses: samples.length,
    avgResponseMs: samples.length ? Math.round(samples.reduce((s, x) => s + x, 0) / samples.length) : null,
    medianResponseMs: median(samples),
    within1hPct: samples.length ? Math.round((samples.filter(x => x <= 3_600_000).length / samples.length) * 100) : null,
    series,
    byCategory: group(c => c.category || 'Sem tipo'),
    byAssignee: group(c => c.assigned_user_id || ''),
  };
}
