'use client';
import {useEffect, useMemo, useState} from 'react';
import {ArrowUpRight, Clock, Hourglass, MessageCircle, Smartphone, Timer, UserPlus} from 'lucide-react';
import {Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import CountUp from '@/components/count-up';
import {waMetrics} from '@/lib/whatsapp-metrics.mjs';
import {waDemo} from '@/lib/whatsapp-demo';

type Metrics = ReturnType<typeof waMetrics>;
type Props = {demo: boolean; members: {id: string; name: string}[]; onAwaiting?: () => void};

function duration(ms: number | null) {
  if (ms === null) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function demoMetrics(days: number): Metrics {
  const seed = waDemo();
  const messages = Object.entries(seed.messages).flatMap(([conversation_id, list]) =>
    list.map((m: {direction: string; source: string; at: string}) => ({conversation_id, direction: m.direction, source: m.source, at: m.at})));
  // Volume extra para o gráfico da demonstração ficar realista
  const now = Date.now();
  const conversations: Record<string, unknown>[] = [...seed.conversations];
  const cats = ['Banho e tosa', 'Produtos', 'Serviços', 'Banho e tosa', 'Informações gerais'];
  for (let d = 1; d < Math.min(days, 30); d++) {
    const n = 3 + ((d * 7) % 5);
    for (let i = 0; i < n; i++) {
      const id = `hist-${d}-${i}`;
      const t = now - d * 86_400_000 - (9 + (i % 8)) * 3_600_000;
      const wait = i % 5 === 0 ? 95 + ((d * 17) % 80) : 4 + ((i * 13 + d) % 45);
      const first = new Date(t).toISOString();
      const reply = new Date(t + wait * 60_000).toISOString();
      conversations.push({id, status: 'resolved', category: cats[(d + i) % cats.length], assigned_user_id: i % 3 === 0 ? 'm1' : i % 3 === 1 ? 'm2' : null,
        first_inbound_at: first, last_inbound_at: first, last_outbound_at: reply, contact: {crm_lead_id: i % 4 === 0 ? 'lead' : null}});
      messages.push({conversation_id: id, direction: 'inbound', source: 'api_inbound', at: first});
      messages.push({conversation_id: id, direction: 'outbound', source: i % 3 ? 'crm' : 'app_echo', at: reply});
    }
  }
  return waMetrics({conversations, messages, days});
}

export default function WhatsAppMetrics({demo, members, onAwaiting}: Props) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Metrics | null>(() => (demo ? demoMetrics(30) : null));
  const [error, setError] = useState('');

  useEffect(() => {
    if (demo) { setData(demoMetrics(days)); return; }
    let alive = true;
    setData(null);
    fetch(`/api/whatsapp?view=metrics&days=${days}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Não foi possível carregar os indicadores.'); return d; })
      .then(d => { if (alive) { setData(d.metrics); setError(''); } })
      .catch(e => alive && setError(e.message));
    return () => { alive = false; };
  }, [days, demo]);

  const name = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members]);
  const m = data;
  const sent = m ? m.sentCrm + m.sentPhone : 0;
  const maxCat = m ? Math.max(1, ...m.byCategory.map(x => x.count)) : 1;
  const maxWho = m ? Math.max(1, ...m.byAssignee.map(x => x.count)) : 1;

  return (
    <div className="wa-metrics">
      <div className="wa-metrics-bar">
        <div className="fin-month wa-period" role="group" aria-label="Período">
          {[7, 30, 90].map(d => (
            <button key={d} className={days === d ? 'active' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>Últimos {d} dias</button>
          ))}
        </div>
        <span className="updated">{demo ? 'Dados ilustrativos' : 'Atualizado agora'}</span>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Conversas no período<MessageCircle size={18} /></div>
          <div className="stat-value">{m ? <CountUp value={m.conversations} format={n => Math.round(n).toLocaleString('pt-BR')} /> : '—'}</div>
          <div className="stat-foot"><span className="tiny-line" />{m ? `${m.newConversations} novas · ${m.received} mensagens` : 'Carregando…'}</div>
        </div>
        <div className="stat-card featured">
          <div className="stat-label">Tempo médio de resposta<Timer size={18} /></div>
          <div className="stat-value">{m ? duration(m.avgResponseMs) : '—'}</div>
          <div className="stat-foot"><span className="tiny-line" />{m?.medianResponseMs != null ? `Metade em até ${duration(m.medianResponseMs)}` : 'Sem respostas no período'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Respondidas em até 1h<Clock size={18} /></div>
          <div className="stat-value">{m?.within1hPct != null ? <CountUp value={m.within1hPct} format={n => `${Math.round(n)}%`} /> : '—'}</div>
          <div className="stat-foot"><span className="tiny-line" />{m ? `${m.responses} ${m.responses === 1 ? 'resposta' : 'respostas'} no período` : ''}</div>
        </div>
        <button type="button" className="stat-card is-link" onClick={onAwaiting}>
          <div className="stat-label">Aguardando resposta<Hourglass size={18} /></div>
          <div className="stat-value">{m ? <CountUp value={m.awaiting} format={n => Math.round(n).toLocaleString('pt-BR')} /> : '—'}</div>
          <div className="stat-foot"><span className="tiny-line" />Agora, sem contar resolvidas<span className="stat-go" aria-hidden="true"><ArrowUpRight size={15} /></span><span className="sr-only">Abrir conversas aguardando resposta</span></div>
        </button>
      </div>

      <div className="chart-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Mensagens por dia</h2>
              <p>Recebidas dos clientes e enviadas pela equipe</p>
            </div>
            <div className="legend"><span><i /> Recebidas</span><span><i className="sent" /> Enviadas</span></div>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={m?.series || []} margin={{top: 10, right: 8, left: -22, bottom: 0}} barGap={2}>
                <CartesianGrid vertical={false} stroke="#1d2c40" strokeDasharray="3 5" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={18} tick={{fill: '#8493aa', fontSize: 12}} dy={8} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{fill: '#8493aa', fontSize: 12}} />
                <Tooltip cursor={{fill: '#4da3ff10'}} contentStyle={{background: '#101f33', border: '1px solid #2b405d', borderRadius: 10}} labelStyle={{color: '#c9d6e8'}} />
                <Bar dataKey="recebidas" name="Recebidas" fill="#4da3ff" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
                <Bar dataKey="enviadas" name="Enviadas" fill="#63d9c1" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-bottom">
            <Smartphone size={16} />
            <span>{m ? `${sent} enviadas: ${m.sentCrm} pelo CRM e ${m.sentPhone} pelo celular` : 'Carregando…'}</span>
          </div>
        </section>

        <section className="panel wa-breakdown">
          <div className="panel-heading">
            <div>
              <h2>Por tipo de atendimento</h2>
              <p>Conversas com mensagem no período</p>
            </div>
          </div>
          <div className="funnel-list">
            {m && !m.byCategory.length && <p className="muted">Nenhuma conversa no período.</p>}
            {m?.byCategory.slice(0, 6).map((c, i) => (
              <div className="funnel-item" key={c.name}>
                <div><span>{c.name}</span><strong>{c.count}</strong></div>
                <div className="funnel-track"><span style={{width: `${(c.count / maxCat) * 100}%`, background: ['#4da3ff', '#7384f5', '#a28bf0', '#e0b666', '#61d5b1', '#8fa6c4'][i % 6]}} /></div>
              </div>
            ))}
          </div>
          <div className="panel-heading wa-sub"><div><h2>Por responsável</h2></div></div>
          <div className="funnel-list">
            {m?.byAssignee.slice(0, 5).map(c => (
              <div className="funnel-item" key={c.name || 'none'}>
                <div><span>{c.name ? name.get(c.name) || 'Equipe' : 'Sem responsável'}</span><strong>{c.count}</strong></div>
                <div className="funnel-track"><span style={{width: `${(c.count / maxWho) * 100}%`, background: c.name ? '#4da3ff' : '#41536d'}} /></div>
              </div>
            ))}
          </div>
          <div className="funnel-summary">
            <span><UserPlus size={14} /> Contatos que viraram lead</span>
            <b>{m ? m.leads : '—'}</b>
          </div>
        </section>
      </div>
    </div>
  );
}
