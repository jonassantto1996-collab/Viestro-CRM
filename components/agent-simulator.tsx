'use client';
import {useEffect, useRef, useState} from 'react';
import {FlaskConical, RotateCcw, Send} from 'lucide-react';
import {toast} from 'sonner';

// Simulador do agente (só o dono da plataforma, em Configurações). Você escreve como cliente e vê
// o que o agente responderia com a configuração salva da empresa. Nada é enviado nem gravado.
type Empresa = {id: string; nome: string; temBase: boolean; ligado: boolean; modo: string; modelo: 'rapido' | 'avancado'; etapas: string[]};
type Sugestao = {resposta: string; precisa_humano: boolean; motivo_humano: string; lead_quente: boolean; intencao: string; etapa?: string};
type Msg = {de: 'cliente' | 'empresa'; texto: string; info?: Sugestao; modelo?: string; segundos?: number};
const NOME_MODELO: Record<string, string> = {rapido: 'Rápido (Haiku)', avancado: 'Avançado (Sonnet)'};

const ATALHOS = ['Quanto custa?', 'Tá caro, faz mais barato?', 'Anda quantos km com a bateria?', 'Aguenta quantos quilos?', 'Vou pensar', 'Hoje não posso', 'Moro no sítio, vocês entregam?'];

export default function AgentSimulator() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [empresa, setEmpresa] = useState('');
  const [etapa, setEtapa] = useState('');
  const [modelo, setModelo] = useState('');
  const [conversa, setConversa] = useState<Msg[]>([]);
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/agente-simulador', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).then(d => {
      const lista: Empresa[] = d?.empresas || [];
      setEmpresas(lista);
      setEmpresa((lista.find(e => e.temBase) || lista[0])?.id || '');
    }).catch(() => {});
  }, []);
  useEffect(() => { fim.current?.scrollIntoView({block: 'nearest'}); }, [conversa, pensando]);

  const atual = empresas.find(e => e.id === empresa);

  async function enviar(msg: string) {
    const t = msg.trim();
    if (!t || pensando || !empresa) return;
    const nova: Msg[] = [...conversa, {de: 'cliente', texto: t}];
    setConversa(nova); setTexto(''); setPensando(true);
    try {
      const r = await fetch('/api/agente-simulador', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({empresa, etapa: etapa || null, modelo: modelo || null, mensagens: nova.slice(-30).map(({de, texto}) => ({de, texto}))})});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Não foi possível simular.');
      const s: Sugestao = j.sugestao;
      setConversa(c => [...c, {de: 'empresa', texto: s.resposta, info: s, modelo: j.modelo, segundos: j.segundos}]);
      if (s.etapa) setEtapa(s.etapa); // o lead "anda" no funil do teste, como no automático
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível simular.');
      setConversa(conversa); setTexto(t);
    } finally { setPensando(false); }
  }

  return <section className="panel settings-panel agent-sim">
    <div className="panel-heading"><h2>Testar o agente</h2><FlaskConical size={19}/></div>
    <p>Só você vê. Escreva como se fosse o cliente e veja o que o agente responderia com a configuração salva da empresa. Nada é enviado ao WhatsApp nem gravado.</p>
    <div className="form-row">
      <label className="field"><span>Empresa</span>
        <select className="agent-select" value={empresa} onChange={e => { setEmpresa(e.target.value); setConversa([]); setEtapa(''); }}>
          {empresas.map(e => <option key={e.id} value={e.id}>{e.nome}{e.temBase ? '' : ' (sem base de conhecimento)'}</option>)}
        </select>
      </label>
      <label className="field"><span>Modelo de IA (só neste teste)</span>
        <select className="agent-select" value={modelo} onChange={e => setModelo(e.target.value)}>
          <option value="">O da empresa{atual ? ` (${NOME_MODELO[atual.modelo]})` : ''}</option>
          <option value="rapido">Rápido (Haiku): barato</option>
          <option value="avancado">Avançado (Sonnet): vende melhor, ~20x o custo</option>
        </select>
      </label>
      <label className="field"><span>Etapa do lead no funil</span>
        <select className="agent-select" value={etapa} onChange={e => setEtapa(e.target.value)}>
          <option value="">Lead novo (sem etapa)</option>
          {(atual?.etapas || []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
    {atual && <small className="muted">Agente {atual.ligado ? 'ligado' : 'desligado'} no WhatsApp ({atual.modo === 'automatico' ? 'automático' : 'sugestão'}). O teste funciona nos dois casos.</small>}
    <div className="sim-chat" aria-live="polite">
      {!conversa.length && <p className="muted">Comece com uma mensagem de cliente ou use um atalho abaixo.</p>}
      {conversa.map((m, i) => <div key={i} className={'sim-msg ' + m.de}>
        <span>{m.texto}</span>
        {m.info && <div className="sim-tags">
          {m.info.lead_quente && <em className="hot">🔥 Lead quente</em>}
          {m.info.precisa_humano && <em className="handoff">Passaria para o atendente{m.info.motivo_humano ? `: ${m.info.motivo_humano}` : ''}</em>}
          {m.info.etapa && <em>Moveria no funil para: {m.info.etapa}</em>}
          {m.modelo && <em className="muted-tag">{NOME_MODELO[m.modelo] || m.modelo}{m.segundos ? ` · ${String(m.segundos).replace('.', ',')} s` : ''}</em>}
        </div>}
      </div>)}
      {pensando && <div className="sim-msg empresa"><span className="muted">Agente escrevendo…</span></div>}
      <div ref={fim}/>
    </div>
    <div className="sim-chips">{ATALHOS.map(a => <button key={a} type="button" disabled={pensando || !empresa} onClick={() => enviar(a)}>{a}</button>)}</div>
    <form className="sim-input" onSubmit={e => { e.preventDefault(); enviar(texto); }}>
      <textarea rows={2} maxLength={1500} placeholder="Mensagem do cliente…" value={texto} onChange={e => setTexto(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(texto); } }}/>
      <div className="sim-actions">
        <button className="button primary" type="submit" disabled={pensando || !texto.trim() || !empresa}><Send size={16}/>Enviar como cliente</button>
        <button className="button secondary" type="button" disabled={pensando || !conversa.length} onClick={() => { setConversa([]); setEtapa(''); }}><RotateCcw size={16}/>Recomeçar</button>
      </div>
    </form>
  </section>;
}
