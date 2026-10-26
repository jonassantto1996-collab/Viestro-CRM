'use client';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, FileText, Info, Lock, MessageCircle, Phone,
  Search, Send, ShieldCheck, Smartphone, User, UserPlus, Users,
} from 'lucide-react';
import {Select, SelectTrigger, SelectValue, SelectContent, SelectItem} from '@/components/ui/select';
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription} from '@/components/ui/sheet';
import {toast} from 'sonner';
import {waDemo} from '@/lib/whatsapp-demo';

type Member = {id: string; name: string; role?: string};
type Props = {
  demo: boolean;
  members: Member[];
  me?: {id: string; role: string} | null;
  onOpenLead?: (leadId: string) => void;
  onLeadCreated?: () => Promise<void> | void;
  initialFilter?: string;
};

// Tipos de atendimento: sugestões + os que a empresa já usa (cada empresa cria os seus digitando)
const DEMO_CATEGORIES = ['Banho e tosa', 'Produtos', 'Serviços', 'Informações gerais', 'Outros'];
const BASE_CATEGORIES = ['Orçamento', 'Dúvida', 'Suporte', 'Pós-venda', 'Financeiro', 'Reclamação', 'Outros'];

function CategoryInput({value, options, onSave}: {value: string; options: string[]; onSave: (v: string) => void}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (v: string) => { const t = v.trim().slice(0, 60); if (t !== value) onSave(t); };
  return (
    <>
      <input list="wa-categories" maxLength={60} placeholder="Escolha ou digite um tipo" value={text} aria-label="Tipo de atendimento"
        onChange={e => { setText(e.target.value); if (options.includes(e.target.value)) commit(e.target.value); }}
        onBlur={() => commit(text)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      <datalist id="wa-categories">{options.map(c => <option key={c} value={c} />)}</datalist>
    </>
  );
}
const STATUS: Record<string, string> = {open: 'Em aberto', pending: 'Pendente', resolved: 'Resolvida'};
const FILTERS = [
  ['all', 'Todas'], ['unread', 'Não lidas'], ['awaiting', 'Aguardando resposta'],
  ['mine', 'Minhas'], ['none', 'Sem responsável'], ['resolved', 'Resolvidas'],
] as const;
const ERRORS: Record<string, string> = {
  window_expired: 'A janela de 24h fechou antes do envio. Use um template.',
  token_missing: 'Número ainda sem token de envio configurado.',
  disconnected: 'Número desconectado do WhatsApp.',
  expired: 'Envio expirou na fila e foi cancelado.',
  unknown_result: 'Resultado desconhecido: confira no WhatsApp antes de reenviar.',
  '131047': 'Mais de 24h desde a última mensagem do cliente.',
  '131026': 'Mensagem não entregue (número sem WhatsApp ou bloqueado).',
  '130429': 'Limite de envio da Meta atingido. Tente em alguns minutos.',
  '190': 'Token de acesso expirado. Reconecte o número.',
  '131042': 'Falta a forma de pagamento na conta do WhatsApp (Gerenciador do WhatsApp > Faturamento).',
  '132000': 'A quantidade de variáveis não confere com o template.',
  '132001': 'Template inexistente ou ainda não aprovado pela Meta.',
  '132015': 'Template pausado pela Meta por baixa qualidade.',
  '132016': 'Template desativado pela Meta.',
};
const SOURCE: Record<string, string> = {crm: 'Pelo CRM', app_echo: 'Pelo celular', history_sync: '', api_inbound: ''};

const initials = (s: string) => s.split(' ').filter(w => /^\p{L}/u.test(w)).map(p => p[0]).slice(0, 2).join('').toUpperCase();
const contactName = (c: any) => c?.contact?.name || phone(c?.contact?.phone_e164) || 'Contato';
function phone(p?: string) {
  const d = (p || '').replace(/\D/g, '');
  if (!d) return p || '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+55 (${d.slice(2, 4)}) ${d.slice(4, d.length - 4)}-${d.slice(-4)}`;
  if (d.startsWith('1') && d.length === 11) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return d.length > 8 ? `+${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}` : `+${d}`;
}
// Cor estável por contato (mesma pessoa, mesma cor em todas as telas)
const TONES = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
function tone(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}
function Avatar({c, size = ''}: {c: any; size?: string}) {
  const name = c?.contact?.name || '';
  const ini = initials(name);
  return (
    <span className={`avatar wa-avatar ${tone(c?.contact?.phone_e164 || c?.id || name)} ${size}`} aria-hidden="true">
      {ini || <User size={size === 'lg' ? 24 : 17} />}
    </span>
  );
}
const lastWasMine = (c: any) => Boolean(c.last_outbound_at && (!c.last_inbound_at || c.last_outbound_at >= c.last_inbound_at));
function when(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'});
}
function dayLabel(iso: string) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return 'Hoje';
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {day: '2-digit', month: 'long', year: 'numeric'});
}
function windowLeft(iso?: string | null) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}
function duration(a?: string | null, b?: string | null) {
  if (!a || !b) return '—';
  const m = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const tplBody = (t: any) => (t?.components || []).find((c: any) => String(c.type).toUpperCase() === 'BODY')?.text || '';
const tplVars = (t: any) => Math.max(0, ...Array.from(tplBody(t).matchAll(/\{\{(\d+)\}\}/g) as Iterable<RegExpMatchArray>).map(m => Number(m[1])));

async function call(body?: any, query = '') {
  const r = await fetch('/api/whatsapp' + query, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined);
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Não foi possível concluir.');
  return d;
}

function Status({m}: {m: any}) {
  if (m.direction !== 'outbound') return null;
  const s = m.message_status;
  if (s === 'failed') return <AlertTriangle size={13} className="wa-tick failed" aria-label="Falhou" />;
  if (s === 'queued') return <Clock size={12} className="wa-tick" aria-label="Na fila" />;
  if (s === 'read') return <CheckCheck size={14} className="wa-tick read" aria-label="Lida" />;
  if (s === 'delivered') return <CheckCheck size={14} className="wa-tick" aria-label="Entregue" />;
  return <Check size={13} className="wa-tick" aria-label="Enviada" />;
}

export default function WhatsAppInbox({demo, members, me, onOpenLead, onLeadCreated, initialFilter}: Props) {
  const seed = useMemo(() => (demo ? waDemo() : null), [demo]);
  const [conversations, setConversations] = useState<any[]>(seed?.conversations || []);
  const [demoMessages, setDemoMessages] = useState<Record<string, any[]>>(seed?.messages || {});
  const [messages, setMessages] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>(seed?.templates || []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>(initialFilter || 'all');
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState('');
  const [sending, setSending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [, tick] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const meId = demo ? 'm1' : me?.id;
  const admin = demo || me?.role === 'admin';

  const selected = conversations.find(c => c.id === selectedId) || null;

  // ----- carregamento (produção) -----
  const loadConversations = useCallback(async () => {
    if (demo) return;
    try {
      const d = await call(undefined, '?view=conversations');
      setConversations(d.conversations || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [demo]);

  const loadMessages = useCallback(async (id: string) => {
    if (demo) return;
    try {
      const d = await call(undefined, `?view=messages&conversation=${id}`);
      setMessages(d.messages || []);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, [demo]);

  useEffect(() => {
    if (demo) return;
    loadConversations();
    call(undefined, '?view=templates&sync=1').then(d => setTemplates(d.templates || [])).catch(() => {});
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadConversations(); }, 10_000);
    return () => clearInterval(t);
  }, [demo, loadConversations]);

  useEffect(() => {
    if (!selectedId || demo) return;
    loadMessages(selectedId);
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadMessages(selectedId); }, 5_000);
    return () => clearInterval(t);
  }, [selectedId, demo, loadMessages]);

  // relógio da janela de 24h
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 30_000); return () => clearInterval(t); }, []);

  const thread = demo ? (selectedId ? demoMessages[selectedId] || [] : []) : messages;
  useEffect(() => { endRef.current?.scrollIntoView({block: 'end'}); }, [thread.length, selectedId]);

  // ----- lista filtrada -----
  const awaiting = (c: any) => Boolean(c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at));
  const visible = conversations.filter(c => {
    if (filter === 'unread' && !c.unread_count) return false;
    if (filter === 'awaiting' && (!awaiting(c) || c.status === 'resolved')) return false;
    if (filter === 'mine' && c.assigned_user_id !== meId) return false;
    if (filter === 'none' && c.assigned_user_id) return false;
    if (filter === 'resolved' ? c.status !== 'resolved' : filter !== 'all' && c.status === 'resolved' && filter !== 'mine') return false;
    const q = query.trim().toLowerCase();
    if (q && !`${c.contact?.name || ''} ${c.contact?.phone_e164 || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
  const count = (key: string) => key === 'unread' ? conversations.filter(c => c.unread_count).length
    : key === 'awaiting' ? conversations.filter(c => awaiting(c) && c.status !== 'resolved').length : 0;

  // ----- ações -----
  function patchLocal(id: string, patch: any) {
    setConversations(cs => cs.map(c => (c.id === id ? {...c, ...patch, contact: {...c.contact, ...(patch.contact || {})}} : c)));
  }

  async function openConversation(c: any) {
    setSelectedId(c.id);
    setText('');
    // No celular a conversa ocupa a tela inteira: rola até ela para o campo de resposta ficar visível.
    if (window.matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => rootRef.current?.scrollIntoView({block: 'start'}));
    if (!demo) setMessages([]);
    if (c.unread_count) {
      patchLocal(c.id, {unread_count: 0});
      if (!demo) call({action: 'mark_read', conversation: c.id}).catch(() => {});
    }
  }

  async function update(patch: any) {
    if (!selected) return;
    const before = {...selected};
    patchLocal(selected.id, patch);
    if (demo) return toast.success('Atualizado na demonstração');
    try {
      await call({action: 'update', conversation: selected.id, patch});
    } catch (e: any) {
      patchLocal(before.id, before);
      toast.error(e.message);
    }
  }

  async function sendText() {
    const body = text.trim();
    if (!selected || !body || sending) return;
    setSending(true);
    const key = newKey();
    const optimistic = {id: 'tmp-' + key, direction: 'outbound', source: 'crm', message_type: 'text', body, message_status: 'queued', sent_by_user_id: meId, at: new Date().toISOString()};
    try {
      if (demo) {
        setDemoMessages(m => ({...m, [selected.id]: [...(m[selected.id] || []), optimistic]}));
        setTimeout(() => setDemoMessages(m => ({...m, [selected.id]: (m[selected.id] || []).map(x => (x.id === optimistic.id ? {...x, message_status: 'delivered'} : x))})), 1200);
      } else {
        setMessages(m => [...m, optimistic]);
        await call({action: 'send_text', conversation: selected.id, text: body, key});
        loadMessages(selected.id);
      }
      patchLocal(selected.id, {last_outbound_at: optimistic.at, last_message_at: optimistic.at, last_message_preview: body.slice(0, 160), unread_count: 0,
        first_response_at: selected.first_response_at || (selected.first_inbound_at ? optimistic.at : null)});
      setText('');
    } catch (e: any) {
      setMessages(m => m.filter(x => x.id !== optimistic.id));
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  }

  async function createLead() {
    if (!selected) return;
    if (demo) {
      patchLocal(selected.id, {contact: {crm_lead_id: 'demo-lead-' + selected.id}});
      return toast.success('Lead criado na demonstração, com tarefa de primeiro contato');
    }
    try {
      const d = await call({action: 'create_lead', conversation: selected.id});
      patchLocal(selected.id, {contact: {crm_lead_id: d.lead}});
      await onLeadCreated?.();
      toast.success('Lead criado no funil, com tarefa de primeiro contato');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const windowText = windowLeft(selected?.service_window_expires_at);
  const memberName = (id?: string | null) => members.find(m => m.id === id)?.name;
  const accountTemplates = templates.filter(t => !selected || t.account_id === selected.account?.id);
  const categoryOptions = Array.from(new Set([...(demo ? DEMO_CATEGORIES : BASE_CATEGORIES), ...conversations.map(c => c.category).filter(Boolean)])) as string[];

  // ----- partes da tela -----
  const details = selected && (
    <div className="wa-details-body">
      <div className="wa-contact-card">
        <Avatar c={selected} size="lg" />
        <strong>{contactName(selected)}</strong>
        <a href={`https://wa.me/${(selected.contact?.phone_e164 || '').replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
          <Phone size={13} /> {selected.contact?.name ? phone(selected.contact?.phone_e164) : 'Abrir no WhatsApp'}
        </a>
        <small>Recebido em {selected.account?.display_name || phone(selected.account?.phone_e164)}</small>
      </div>

      <label className="field">
        <span>Status do atendimento</span>
        <Select value={selected.status} onValueChange={v => update({status: v})}>
          <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <label className="field">
        <span>Tipo de atendimento</span>
        <CategoryInput key={selected.id} value={selected.category || ''} options={categoryOptions} onSave={v => update({category: v})} />
      </label>
      <label className="field">
        <span>Responsável</span>
        <Select value={selected.assigned_user_id || 'none'} onValueChange={v => update({assigned_user_id: v === 'none' ? null : v})}>
          <SelectTrigger aria-label="Responsável"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Ninguém</SelectItem>
            {members.filter(m => admin || m.id === meId || m.id === selected.assigned_user_id).map(m => (
              <SelectItem key={m.id} value={m.id}>{m.id === meId ? `${m.name} (você)` : m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <section className="wa-box">
        <h3>Oportunidade</h3>
        {selected.contact?.crm_lead_id ? (
          <>
            <p className="wa-ok"><Check size={14} /> Lead vinculado no funil</p>
            {!demo && onOpenLead && <button className="button secondary full" onClick={() => onOpenLead(selected.contact.crm_lead_id)}>Abrir lead</button>}
          </>
        ) : (
          <>
            <p>Este contato ainda não está no funil de vendas.</p>
            <button className="button primary full" onClick={createLead}><UserPlus size={16} /> Criar lead</button>
          </>
        )}
      </section>

      <section className="wa-box">
        <h3>Indicadores da conversa</h3>
        <dl>
          <div><dt>Primeiro contato</dt><dd>{when(selected.first_inbound_at) || '—'}</dd></div>
          <div><dt>Tempo até a 1ª resposta</dt><dd>{duration(selected.first_inbound_at, selected.first_response_at)}</dd></div>
          <div><dt>Janela de 24h</dt><dd>{windowText ? `aberta · ${windowText}` : 'fechada'}</dd></div>
        </dl>
      </section>

      <section className="wa-box">
        <h3>Marketing</h3>
        {selected.contact?.marketing_opt_out_at ? (
          <p className="wa-warn"><Lock size={14} /> Pediu para não receber promoções.</p>
        ) : (
          <p>Promoções só com autorização registrada do cliente.</p>
        )}
        <button className="button secondary full" onClick={() => setConsentOpen(true)}><ShieldCheck size={15} /> Registrar autorização</button>
      </section>
    </div>
  );

  let lastDay = '';
  return (
    <div ref={rootRef} className={'wa-inbox' + (selected ? ' has-selection' : '')}>
      {/* Lista */}
      <section className="panel wa-list" aria-label="Conversas">
        <div className="wa-list-head">
          <div className="wa-list-title">
            <h2>Conversas</h2>
            {conversations.length > 0 && <span>{conversations.length}</span>}
          </div>
          <div className="search wa-search">
            <Search size={15} />
            <input placeholder="Buscar nome ou telefone" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar conversas" />
          </div>
          <div className="wa-filters" role="tablist">
            {FILTERS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                {label}{count(k) > 0 && <b>{count(k)}</b>}
              </button>
            ))}
          </div>
        </div>
        <div className="wa-list-body">
          {loading && <div className="empty"><Clock size={24} /><p>Carregando conversas…</p></div>}
          {!loading && loadError && <div className="notice error">{loadError} <button onClick={loadConversations}>Tentar novamente</button></div>}
          {!loading && !loadError && !visible.length && (
            <div className="empty">
              <MessageCircle size={28} />
              <p>{conversations.length ? 'Nenhuma conversa neste filtro.' : 'Nenhuma conversa ainda. Quando o número estiver conectado, as mensagens aparecem aqui.'}</p>
            </div>
          )}
          {visible.map(c => (
            <button key={c.id} className={'wa-item' + (c.id === selectedId ? ' active' : '') + (c.unread_count ? ' unread' : '')} onClick={() => openConversation(c)}>
              <Avatar c={c} />
              <span className="wa-item-main">
                <span className="wa-item-top">
                  <strong>{contactName(c)}</strong>
                  <time>{when(c.last_message_at)}</time>
                </span>
                <span className="wa-item-preview">
                  {c.last_message_preview && lastWasMine(c) && <span className="wa-you"><CheckCheck size={13} />Você:</span>}
                  {c.last_message_preview || 'Sem mensagens'}
                </span>
                <span className="wa-item-tags">
                  {awaiting(c) && c.status !== 'resolved' && <span className="wa-tag awaiting">Aguardando resposta</span>}
                  {c.status === 'pending' && <span className="wa-tag">Pendente</span>}
                  {c.status === 'resolved' && <span className="wa-tag done">Resolvida</span>}
                  {c.category && <span className="wa-tag cat">{c.category}</span>}
                  {c.assigned_user_id && <span className="wa-tag who"><Users size={11} />{memberName(c.assigned_user_id) || 'Equipe'}</span>}
                </span>
              </span>
              {c.unread_count > 0 && <span className="wa-unread" aria-label={`${c.unread_count} não lidas`}>{c.unread_count}</span>}
            </button>
          ))}
        </div>
      </section>

      {/* Conversa */}
      <section className="panel wa-thread" aria-label="Conversa">
        {!selected ? (
          <div className="wa-placeholder">
            <span className="wa-placeholder-icon"><MessageCircle size={30} /></span>
            <h2>Selecione uma conversa</h2>
            <p>Responda pelo CRM ou pelo celular: tudo fica registrado no mesmo histórico.</p>
            <ul className="wa-hints">
              <li><Send size={13} /> Resposta pelo CRM</li>
              <li><Smartphone size={13} /> Celular sincronizado</li>
              <li><Clock size={13} /> Janela de 24h visível</li>
            </ul>
          </div>
        ) : (
          <>
            <header className="wa-thread-head">
              <button className="wa-back" onClick={() => setSelectedId(null)} aria-label="Voltar para a lista"><ArrowLeft size={18} /></button>
              <Avatar c={selected} />
              <div className="wa-thread-title">
                <strong>{contactName(selected)}</strong>
                <small>{selected.contact?.name ? `${phone(selected.contact?.phone_e164)} · ` : ''}{STATUS[selected.status]}{selected.category ? ` · ${selected.category}` : ''}</small>
              </div>
              <span className={'wa-window ' + (windowText ? 'open' : 'closed')} title="Janela de 24h da Meta para responder sem template">
                <Clock size={13} /> {windowText ? `Aberta · ${windowText}` : 'Janela fechada'}
              </span>
              <button className="button secondary wa-details-btn" onClick={() => setDetailsOpen(true)}><Info size={15} /> Detalhes</button>
            </header>

            <div className="wa-messages" key={selected.id}>
              {thread.some((m: any) => m.source === 'history_sync') && (
                <div className="wa-history-note"><Smartphone size={13} /> Conversas anteriores importadas do WhatsApp do celular</div>
              )}
              {thread.map((m: any) => {
                const d = dayLabel(m.at);
                const sep = d !== lastDay ? (lastDay = d) : null;
                return (
                  <div key={m.id} className="wa-row">
                    {sep && <div className="wa-day"><span>{sep}</span></div>}
                    <div className={'wa-msg ' + m.direction + (m.message_status === 'failed' ? ' failed' : '')}>
                      {m.template_name && <span className="wa-msg-tpl"><FileText size={12} /> Template · {m.template_name}</span>}
                      <p>{m.body || `[${m.message_type}]`}</p>
                      <span className="wa-msg-meta">
                        {SOURCE[m.source] && <em>{m.source === 'app_echo' && <Smartphone size={11} />}{SOURCE[m.source]}{m.source === 'crm' && memberName(m.sent_by_user_id) ? ` · ${memberName(m.sent_by_user_id)}` : ''}</em>}
                        <time>{new Date(m.at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</time>
                        <Status m={m} />
                      </span>
                      {m.message_status === 'failed' && <span className="wa-msg-error">{ERRORS[m.error_code] || 'Não foi possível enviar esta mensagem.'}</span>}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            <footer className="wa-composer">
              {windowText ? (
                <>
                  <textarea
                    rows={2}
                    maxLength={4096}
                    placeholder="Escreva uma resposta… (Enter envia, Shift+Enter quebra linha)"
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }}
                    aria-label="Mensagem"
                  />
                  <div className="wa-composer-actions">
                    <button className="button secondary" onClick={() => setTplOpen(true)} title="Enviar template aprovado"><FileText size={15} /> Template</button>
                    <button className="button primary" disabled={!text.trim() || sending} onClick={sendText}><Send size={15} /> {sending ? 'Enviando…' : 'Enviar'}</button>
                  </div>
                </>
              ) : (
                <div className="wa-closed">
                  <Lock size={16} />
                  <p><strong>Janela de 24h fechada.</strong> Pela regra da Meta, só é possível retomar a conversa com um template aprovado, ou respondendo pelo celular se o cliente escrever de novo.</p>
                  <button className="button primary" onClick={() => setTplOpen(true)}><FileText size={15} /> Enviar template</button>
                </div>
              )}
            </footer>
          </>
        )}
      </section>

      {/* Detalhes (coluna em telas grandes) */}
      <aside className="panel wa-details" aria-label="Detalhes do contato">
        {details || <div className="wa-placeholder small"><Info size={24} /><p>Os dados do contato aparecem aqui.</p></div>}
      </aside>

      {/* Detalhes (gaveta em telas menores) */}
      <Sheet open={detailsOpen && !!selected} onOpenChange={setDetailsOpen}>
        <SheetContent className="lead-sheet">
          <SheetHeader>
            <span className="eyebrow">CONTATO</span>
            <SheetTitle>{selected ? contactName(selected) : ''}</SheetTitle>
            <SheetDescription>{phone(selected?.contact?.phone_e164)}</SheetDescription>
          </SheetHeader>
          <div className="sheet-body">{details}</div>
        </SheetContent>
      </Sheet>

      <TemplateDialog
        onRefresh={demo ? undefined : () => call(undefined, '?view=templates&sync=1').then(d => setTemplates(d.templates || [])).catch(() => {})}
        open={tplOpen}
        onOpenChange={setTplOpen}
        templates={accountTemplates}
        contact={selected}
        demo={demo}
        onSent={(body: string, name: string) => {
          if (!selected) return;
          const now = new Date().toISOString();
          if (demo) setDemoMessages(m => ({...m, [selected.id]: [...(m[selected.id] || []), {id: 'tpl-' + now, direction: 'outbound', source: 'crm', message_type: 'template', template_name: name, body, message_status: 'sent', sent_by_user_id: meId, at: now}]}));
          else loadMessages(selected.id);
          patchLocal(selected.id, {last_outbound_at: now, last_message_at: now, last_message_preview: body.slice(0, 160)});
        }}
      />
      <ConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        contact={selected?.contact}
        demo={demo}
        onDone={(revoked: boolean) => selected && patchLocal(selected.id, {contact: {marketing_opt_out_at: revoked ? new Date().toISOString() : null}})}
      />
    </div>
  );
}

const TPL_STATUS: Record<string, string> = {PENDING: 'em análise pela Meta', REJECTED: 'recusado pela Meta', PAUSED: 'pausado pela Meta', DISABLED: 'desativado pela Meta', IN_APPEAL: 'em recurso na Meta', LIMIT_EXCEEDED: 'limite atingido', ARCHIVED: 'arquivado', PENDING_DELETION: 'sendo removido'};

function TemplateDialog({open, onOpenChange, templates: all, contact, demo, onSent, onRefresh}: any) {
  const templates = all.filter((x: any) => x.status === 'APPROVED');
  const others = all.filter((x: any) => x.status !== 'APPROVED');
  useEffect(() => { if (open) onRefresh?.(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [id, setId] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const t = templates.find((x: any) => x.id === id);
  const n = t ? tplVars(t) : 0;
  useEffect(() => { if (open && !templates.some((x: any) => x.id === id)) setId(templates[0]?.id || ''); }, [open, templates.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const first = (contact?.contact?.name || '').split(' ')[0];
    setParams(Array.from({length: n}, (_, i) => (i === 0 ? first : '')));
  }, [id, n, contact?.id]);
  const preview = tplBody(t).replace(/\{\{(\d+)\}\}/g, (_: string, i: string) => params[Number(i) - 1] || `{{${i}}}`);
  const ready = t && params.every(p => p.trim());

  async function send() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (!demo) await call({action: 'send_template', conversation: contact.id, template: t.id, params: params.map(p => p.trim()), key: newKey()});
      else if (t.category === 'MARKETING') throw new Error('Sem consentimento registrado para marketing');
      onSent(preview, t.name);
      toast.success('Template enviado');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="crm-modal">
        <DialogHeader>
          <DialogTitle>Enviar template aprovado</DialogTitle>
          <DialogDescription>Templates são mensagens aprovadas pela Meta. São a única forma de iniciar ou retomar uma conversa após 24h. Promoções exigem autorização registrada do cliente.</DialogDescription>
        </DialogHeader>
        {others.length > 0 && (
          <ul className="wa-tpl-others">
            {others.map((x: any) => <li key={x.id}><FileText size={13} /> <strong>{x.name}</strong> <span className={x.status === 'PENDING' ? 'pending' : 'bad'}>{TPL_STATUS[x.status] || x.status.toLowerCase()}</span></li>)}
          </ul>
        )}
        {!templates.length ? (
          <div className="notice">{others.some((x: any) => x.status === 'PENDING')
            ? 'Os templates acima estão em análise na Meta (normalmente minutos, até 24h). Assim que forem aprovados, aparecem aqui para envio.'
            : 'Nenhum template aprovado para este número ainda. Eles são criados e aprovados na Meta e aparecem aqui automaticamente.'}</div>
        ) : (
          <>
            <label className="field">
              <span>Template</span>
              <Select value={id} onValueChange={setId}>
                <SelectTrigger aria-label="Template"><SelectValue placeholder="Escolha um template" /></SelectTrigger>
                <SelectContent>
                  {templates.map((x: any) => <SelectItem key={x.id} value={x.id}>{x.name} · {x.category === 'MARKETING' ? 'Promoção' : 'Atendimento'}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            {params.map((p, i) => (
              <label className="field" key={i}>
                <span>Variável {`{{${i + 1}}}`}</span>
                <input value={p} maxLength={1024} onChange={e => setParams(ps => ps.map((x, j) => (j === i ? e.target.value : x)))} />
              </label>
            ))}
            {t && <div className="wa-tpl-preview"><small>Prévia</small><p>{preview}</p></div>}
            {t?.category === 'MARKETING' && <div className="notice"><ShieldCheck size={15} /> Promoção: só é enviada se o cliente tiver autorização registrada e não tiver pedido para sair. Máximo de 1 por dia.</div>}
            <button className="button primary full" disabled={!ready || busy} onClick={send}><Send size={15} /> {busy ? 'Enviando…' : 'Enviar template'}</button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConsentDialog({open, onOpenChange, contact, demo, onDone}: any) {
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setEvidence(''); }, [open]);
  async function save(status: 'granted' | 'revoked') {
    if (!contact || busy) return;
    if (status === 'granted' && !evidence.trim()) return toast.error('Descreva como o cliente autorizou.');
    setBusy(true);
    try {
      if (!demo) await call({action: 'consent', contact: contact.id, purpose: 'marketing', status, evidence: evidence.trim() || null});
      onDone(status === 'revoked');
      toast.success(status === 'granted' ? 'Autorização registrada' : 'Autorização revogada');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="crm-modal">
        <DialogHeader>
          <DialogTitle>Autorização para promoções</DialogTitle>
          <DialogDescription>Registre como o cliente autorizou receber promoções pelo WhatsApp (LGPD e regras da Meta). Lista importada não vale como autorização.</DialogDescription>
        </DialogHeader>
        <label className="field">
          <span>Como o cliente autorizou</span>
          <textarea rows={3} maxLength={1000} placeholder="Ex.: pediu para receber promoções no balcão em 24/10, atendida por Ana" value={evidence} onChange={e => setEvidence(e.target.value)} />
        </label>
        <div className="wa-dialog-actions">
          <button className="button secondary" disabled={busy} onClick={() => save('revoked')}>Revogar autorização</button>
          <button className="button primary" disabled={busy || !evidence.trim()} onClick={() => save('granted')}><ShieldCheck size={15} /> Registrar</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
