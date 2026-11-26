'use client';
import {useEffect, useState} from 'react';
import {Download, Megaphone, RefreshCw, ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import {Switch} from '@/components/ui/switch';
import {downloadCsv} from '@/lib/export';
import {COLUNAS_PLANILHA, linhasDaPlanilha, MODELOS_REMARKETING, REMARKETING_PADRAO, remarketingValido} from '@/lib/remarketing.mjs';

// Remarketing automático (Configurações › Agente). Salva em settings.remarketing (desligado por padrão).
// O painel mostra os envios (hoje, 7 e 30 dias), respostas, opt-outs e quantos estão na fila, com exportação.
type Resumo = {hoje: number; semana: number; mes: number; respostas: number; optouts: number; fila: number; optouts_total: number};

export default function RemarketingSettings({company, admin, demo, onSave}: {company: any; admin: boolean; demo: boolean; onSave: (c: any) => Promise<void> | void}) {
  const [r, setR] = useState<any>({...REMARKETING_PADRAO, ...(company.settings?.remarketing || {})});
  const [salvando, setSalvando] = useState(false);
  const [painel, setPainel] = useState<{resumo: Resumo | null; envios: any[]} | null>(null);
  const [carregando, setCarregando] = useState(false);
  useEffect(() => setR({...REMARKETING_PADRAO, ...(company.settings?.remarketing || {})}), [company]);
  const set = (patch: any) => setR((x: any) => ({...x, ...patch}));
  const num = (v: string) => (v === '' ? NaN : Math.round(Number(v)));

  async function carregar() {
    if (demo) return;
    setCarregando(true);
    try {
      const res = await fetch('/api/whatsapp?view=remarketing', {cache: 'no-store'});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Não foi possível carregar o remarketing.');
      setPainel({resumo: j.resumo, envios: j.envios || []});
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível carregar o remarketing.'); }
    finally { setCarregando(false); }
  }
  useEffect(() => { carregar(); }, [demo]); // eslint-disable-line react-hooks/exhaustive-deps

  async function salvar() {
    const cfg = {enabled: !!r.enabled, days: num(String(r.days)), max_attempts: num(String(r.max_attempts)), daily_limit: num(String(r.daily_limit)),
      send_days: r.send_days, start: r.start, end: r.end};
    if (!remarketingValido(cfg)) {
      toast.error(cfg.start >= cfg.end ? 'O horário de terminar precisa ser depois do de começar.' : 'Revise os números: dias de 1 a 90, tentativas de 1 a 3, limite de 1 a 1.000.');
      return;
    }
    setSalvando(true);
    try { await onSave({...company, settings: {...company.settings, remarketing: cfg}}); } finally { setSalvando(false); }
  }

  function exportar() {
    if (!painel?.envios.length) { toast.info('Nenhum envio nos últimos 30 dias.'); return; }
    downloadCsv(`remarketing-${new Date().toISOString().slice(0, 10)}.csv`, COLUNAS_PLANILHA, linhasDaPlanilha(painel.envios));
  }

  const s = painel?.resumo;
  return <section className="panel settings-panel agent-settings">
    <div className="panel-heading"><h2>Remarketing automático</h2><Megaphone size={19}/></div>
    <p>Lembra quem parou de responder, com os modelos de marketing aprovados pela Meta (um por tentativa). Quando o cliente responde, o agente volta a atender normalmente.</p>
    <label className="agent-toggle"><Switch checked={!!r.enabled} disabled={!admin} onCheckedChange={(v: boolean) => set({enabled: v})}/><span>{r.enabled ? 'Remarketing ligado' : 'Remarketing desligado'}</span></label>
    <div className="form-row">
      <label className="field"><span>Dias sem resposta</span><input type="number" min={1} max={90} disabled={!admin} value={r.days} onChange={e => set({days: e.target.value})}/></label>
      <label className="field"><span>Tentativas máximas</span><input type="number" min={1} max={3} disabled={!admin} value={r.max_attempts} onChange={e => set({max_attempts: e.target.value})}/></label>
      <label className="field"><span>Limite por número por dia</span><input type="number" min={1} max={1000} disabled={!admin} value={r.daily_limit} onChange={e => set({daily_limit: e.target.value})}/></label>
    </div>
    <div className="form-row agent-office">
      <label className="field"><span>Dias de envio</span>
        <select className="agent-select" disabled={!admin} value={r.send_days} onChange={e => set({send_days: e.target.value})}>
          <option value="seg-sab">Segunda a sábado</option><option value="seg-sex">Segunda a sexta</option>
        </select>
      </label>
      <label className="field"><span>Começa às</span><input type="time" disabled={!admin} value={r.start} onChange={e => set({start: e.target.value})}/></label>
      <label className="field"><span>Termina às</span><input type="time" disabled={!admin} value={r.end} onChange={e => set({end: e.target.value})}/></label>
    </div>
    <ul className="agent-safety">
      <li><ShieldCheck size={14}/>Vai para leads com telefone, fora de Ganho, que ficaram {Number(r.days) || 10} dias sem responder (quem nunca conversou conta da criação do lead).</li>
      <li><ShieldCheck size={14}/>No máximo 1 mensagem a cada {Number(r.days) || 10} dias e {Number(r.max_attempts) || 3} tentativas seguidas sem resposta; se o cliente responder, a contagem zera.</li>
      <li><ShieldCheck size={14}/>Quem responde SAIR, PARAR, STOP ou "não quero mais" nunca mais recebe, ganha uma confirmação e fica registrado no lead.</li>
      <li><ShieldCheck size={14}/>Sai pelo número da última conversa; sem conversa, pelo número do responsável; sem responsável, reveza entre os números. Os envios se espalham ao longo do horário.</li>
      <li><ShieldCheck size={14}/>Só envia modelo aprovado: {MODELOS_REMARKETING.map(m => m.name).join(', ')}.</li>
    </ul>
    {admin && <button className="button primary" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : demo ? 'Salvar na demonstração' : 'Salvar remarketing'}</button>}

    {!demo && <div className="remarketing-panel">
      <div className="panel-heading"><h3>Resultados</h3>
        <div className="form-row">
          <button className="button secondary" disabled={carregando} onClick={carregar}><RefreshCw size={15}/>{carregando ? 'Atualizando…' : 'Atualizar'}</button>
          <button className="button secondary" onClick={exportar}><Download size={15}/>Exportar planilha</button>
        </div>
      </div>
      <div className="remarketing-stats">
        <div><b>{s?.hoje ?? '–'}</b><span>enviados hoje</span></div>
        <div><b>{s?.semana ?? '–'}</b><span>em 7 dias</span></div>
        <div><b>{s?.mes ?? '–'}</b><span>em 30 dias</span></div>
        <div><b>{s?.respostas ?? '–'}</b><span>responderam (30 dias)</span></div>
        <div><b>{s?.optouts ?? '–'}</b><span>pediram para sair (30 dias)</span></div>
        <div><b>{s?.fila ?? '–'}</b><span>na fila</span></div>
      </div>
    </div>}
  </section>;
}
