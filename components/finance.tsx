'use client';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ArrowDownRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleDollarSign, Clock, Download,
  Link2, Plus, Receipt, Scale, Search, Trash2, Wallet,
} from 'lucide-react';
import {Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {toast} from 'sonner';
import CountUp from '@/components/count-up';
import {downloadCsv, sheetDate, sheetNumber} from '@/lib/export';
import {financeDemo} from '@/lib/finance-demo';
import {petshopFinance} from '@/lib/demo-petshop';
import {demoVariant} from '@/lib/demo';

export type FinanceEntry = {
  id?: string; kind: 'income' | 'expense'; occurred_on: string; description: string; category: string;
  client_name?: string | null; lead_id?: string | null; amount_cents: number; method?: string | null;
  status: 'paid' | 'pending'; paid_on?: string | null; notes?: string | null;
};
type Props = {
  demo: boolean;
  leads: {id: string; name: string}[];
  draft?: Partial<FinanceEntry> | null;
  onDraftUsed?: () => void;
};

const METHODS: Record<string, string> = {
  pix: 'Pix', dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito',
  boleto: 'Boleto', transferencia: 'Transferência', outro: 'Outro',
};
const INCOME_CATS = ['Gestão de tráfego', 'Site ou landing page', 'Sistema sob medida', 'CRM', 'Identidade visual', 'Social media', 'Consultoria', 'Mensalidade', 'Outros'];
const EXPENSE_CATS = ['Ferramentas e assinaturas', 'Anúncios', 'Equipe', 'Impostos', 'Aluguel e estrutura', 'Outros'];
type Filter = 'all' | 'income' | 'received' | 'receivable' | 'expense';

const brl = (cents: number) => new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'}).format((cents || 0) / 100);
const plain = (cents: number) => new Intl.NumberFormat('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}).format((cents || 0) / 100);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const monthKey = (d: Date) => iso(d).slice(0, 7);
function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}
function monthName(key: string, style: 'long' | 'short' = 'long') {
  const [y, m] = key.split('-').map(Number);
  const name = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', {month: style}).replace('.', '');
  return style === 'long' ? `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${y}` : name;
}
const lastDay = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return iso(new Date(y, m, 0));
};
const shortDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', {day: '2-digit', month: 'short'}).replace('.', '').replace(' de ', ' ');
const statusLabel = (e: FinanceEntry) => (e.kind === 'income' ? (e.status === 'paid' ? 'Recebido' : 'A receber') : (e.status === 'paid' ? 'Pago' : 'A pagar'));

async function call(body?: unknown, query = '') {
  const r = await fetch('/api/finance' + query, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Não foi possível concluir.');
  return d;
}

export default function Finance({demo, leads, draft, onDraftUsed}: Props) {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [entries, setEntries] = useState<FinanceEntry[]>(() => (demo ? (demoVariant() === 'petshop' ? petshopFinance() as FinanceEntry[] : financeDemo()) : []));
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<FinanceEntry | null>(null);

  const from = `${shiftMonth(month, -5)}-01`;
  const to = lastDay(month);

  const load = useCallback(async () => {
    if (demo) return;
    setLoading(true);
    try {
      const d = await call(undefined, `?from=${from}&to=${to}`);
      setEntries(d.entries || []);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [demo, from, to]);
  useEffect(() => { load(); }, [load]);

  // Lançamento sugerido a partir do funil (oportunidade ganha)
  useEffect(() => {
    if (!draft) return;
    setForm({kind: 'income', occurred_on: today(), description: '', category: 'Outros', amount_cents: 0, status: 'pending', method: null, ...draft});
    onDraftUsed?.();
  }, [draft, onDraftUsed]);

  const inMonth = useMemo(() => entries.filter(e => e.occurred_on.slice(0, 7) === month), [entries, month]);
  const sum = (list: FinanceEntry[]) => list.reduce((s, e) => s + Number(e.amount_cents || 0), 0);
  const incomes = inMonth.filter(e => e.kind === 'income');
  const expenses = inMonth.filter(e => e.kind === 'expense');
  const billed = sum(incomes);
  const received = sum(incomes.filter(e => e.status === 'paid'));
  const receivable = billed - received;
  const spent = sum(expenses);
  const toPay = sum(expenses.filter(e => e.status === 'pending'));
  const result = billed - spent;

  const chart = useMemo(() => Array.from({length: 6}, (_, i) => {
    const key = shiftMonth(month, i - 5);
    const list = entries.filter(e => e.occurred_on.slice(0, 7) === key);
    return {
      key, label: monthName(key, 'short'),
      Entradas: list.filter(e => e.kind === 'income').reduce((s, e) => s + e.amount_cents, 0) / 100,
      Despesas: list.filter(e => e.kind === 'expense').reduce((s, e) => s + e.amount_cents, 0) / 100,
    };
  }), [entries, month]);

  const visible = inMonth.filter(e => {
    if (filter === 'income' && e.kind !== 'income') return false;
    if (filter === 'received' && !(e.kind === 'income' && e.status === 'paid')) return false;
    if (filter === 'receivable' && !(e.kind === 'income' && e.status === 'pending')) return false;
    if (filter === 'expense' && e.kind !== 'expense') return false;
    const q = query.trim().toLowerCase();
    return !q || `${e.description} ${e.category} ${e.client_name || ''}`.toLowerCase().includes(q);
  }).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));

  const cards: [Filter, string, number, string, typeof Wallet, string][] = [
    ['income', 'Faturado no mês', billed, `${incomes.length} ${incomes.length === 1 ? 'entrada' : 'entradas'}`, Receipt, ''],
    ['received', 'Recebido', received, billed ? `${Math.round((received / billed) * 100)}% do faturado` : 'Nada faturado ainda', Check, 'good'],
    ['receivable', 'A receber', receivable, `${incomes.filter(e => e.status === 'pending').length} em aberto`, Clock, 'warn'],
    ['expense', 'Despesas', spent, toPay ? `${brl(toPay)} a pagar` : 'Tudo pago', ArrowDownRight, ''],
    ['all', 'Resultado do mês', result, 'Faturado − despesas', Scale, result >= 0 ? 'good' : 'bad'],
  ];

  function exportMonth() {
    if (!inMonth.length) return toast.info('Nenhum lançamento neste mês para exportar.');
    const rows = [...inMonth].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on)).map(e => [
      sheetDate(e.occurred_on), e.kind === 'income' ? 'Entrada' : 'Despesa', e.description, e.category, e.client_name || '',
      e.method ? METHODS[e.method] : '', statusLabel(e), sheetDate(e.paid_on), sheetNumber((e.kind === 'income' ? 1 : -1) * e.amount_cents / 100), e.notes || '',
    ]);
    rows.push([], ['', '', 'Faturado no mês', '', '', '', '', '', sheetNumber(billed / 100), ''],
      ['', '', 'Despesas', '', '', '', '', '', sheetNumber(-spent / 100), ''],
      ['', '', 'Resultado do mês', '', '', '', '', '', sheetNumber(result / 100), '']);
    downloadCsv(`viestro-financeiro-${month}.csv`,
      ['Data', 'Tipo', 'Descrição', 'Serviço ou categoria', 'Cliente', 'Forma de pagamento', 'Situação', 'Data do pagamento', 'Valor (R$)', 'Observações'], rows);
    toast.success(`Financeiro de ${monthName(month).toLowerCase()} exportado`);
  }

  async function save(entry: FinanceEntry) {
    if (demo) {
      const e = {...entry, id: entry.id || `demo-fin-${Date.now()}`, paid_on: entry.status === 'paid' ? entry.paid_on || entry.occurred_on : null};
      setEntries(list => (list.some(x => x.id === e.id) ? list.map(x => (x.id === e.id ? e : x)) : [e, ...list]));
      toast.success('Lançamento salvo na demonstração');
    } else {
      await call({action: 'save', entry});
      toast.success('Lançamento salvo');
      await load();
    }
    if (entry.occurred_on.slice(0, 7) !== month) setMonth(entry.occurred_on.slice(0, 7));
  }
  async function remove(id: string) {
    if (demo) setEntries(list => list.filter(x => x.id !== id));
    else { await call({action: 'delete', id}); await load(); }
    toast.success('Lançamento excluído');
  }

  const newEntry = (kind: 'income' | 'expense') => {
    const day = month === monthKey(new Date()) ? today() : `${month}-01`;
    setForm({kind, occurred_on: day, description: '', category: '', client_name: '', lead_id: null, amount_cents: 0, method: 'pix', status: 'paid', paid_on: day, notes: ''});
  };

  return (
    <div className="finance">
      <div className="fin-toolbar">
        <div className="fin-month" role="group" aria-label="Mês">
          <button onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Mês anterior"><ChevronLeft size={18} /></button>
          <strong>{monthName(month)}</strong>
          <button onClick={() => setMonth(m => shiftMonth(m, 1))} aria-label="Próximo mês"><ChevronRight size={18} /></button>
          {month !== monthKey(new Date()) && <button className="fin-today" onClick={() => setMonth(monthKey(new Date()))}>Mês atual</button>}
        </div>
        <div className="fin-actions">
          <button className="button secondary" onClick={exportMonth}><Download size={16} /> Exportar</button>
          <button className="button secondary" onClick={() => newEntry('expense')}><ArrowDownRight size={16} /> Despesa</button>
          <button className="button primary" onClick={() => newEntry('income')}><Plus size={17} /> Entrada</button>
        </div>
      </div>

      {loadError && <div className="notice error">{loadError} <button className="text-link" onClick={load}>Tentar novamente</button></div>}

      <div className="stat-grid fin-stats">
        {cards.map(([key, label, value, sub, Icon, tone], i) => (
          <button type="button" key={label} className={`stat-card is-link fin-stat ${tone} ${filter === key && key !== 'all' ? 'selected' : ''} ${i === 4 ? 'featured' : ''}`}
            onClick={() => setFilter(f => (f === key ? 'all' : key))} aria-pressed={filter === key}>
            <div className="stat-label">{label}<Icon size={18} /></div>
            <div className="stat-value"><CountUp value={value} format={n => brl(Math.round(n))} /></div>
            <div className="stat-foot"><span className="tiny-line" />{sub}<span className="stat-go" aria-hidden="true"><ArrowUpRight size={15} /></span></div>
          </button>
        ))}
      </div>

      <div className="fin-grid">
        <section className="panel fin-list">
          <div className="panel-heading">
            <div>
              <h2>Lançamentos <span className="counter">{visible.length}</span></h2>
              <p>{filter === 'all' ? 'Tudo o que entrou e saiu no mês' : cards.find(c => c[0] === filter)?.[1]}{filter !== 'all' && <button className="fin-clear" onClick={() => setFilter('all')}>Ver todos</button>}</p>
            </div>
            <div className="search">
              <Search size={16} />
              <input placeholder="Buscar descrição ou cliente" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar lançamentos" />
            </div>
          </div>
          {loading ? (
            <div className="empty"><Clock size={24} /><p>Carregando lançamentos…</p></div>
          ) : !visible.length ? (
            <div className="empty">
              <CircleDollarSign size={28} />
              <p>{inMonth.length ? 'Nenhum lançamento neste filtro.' : `Nenhum lançamento em ${monthName(month).toLowerCase()}.`}</p>
              {!inMonth.length && <button className="button primary" onClick={() => newEntry('income')}><Plus size={16} /> Lançar primeira entrada</button>}
            </div>
          ) : (
            <div className="fin-rows" role="list">
              {visible.map(e => (
                <button key={e.id} role="listitem" className={`fin-row ${e.kind}`} onClick={() => setForm({...e})}>
                  <span className="fin-date">{shortDate(e.occurred_on)}</span>
                  <span className="fin-desc">
                    <strong>{e.description}</strong>
                    <small>
                      <span className="fin-cat">{e.category}</span>
                      {e.client_name && <span>· {e.client_name}</span>}
                      {e.lead_id && <Link2 size={11} aria-label="Vinculado ao funil" />}
                    </small>
                  </span>
                  <span className="fin-method">{e.method ? METHODS[e.method] : '—'}</span>
                  <span className="fin-status"><span className={`fin-pill ${e.status}`}>{statusLabel(e)}</span></span>
                  <span className="fin-value">{e.kind === 'income' ? '+ ' : '− '}{brl(e.amount_cents)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel fin-chart">
          <div className="panel-heading">
            <div>
              <h2>Últimos 6 meses</h2>
              <p>Entradas e despesas por mês</p>
            </div>
            <div className="legend"><span><i /> Entradas</span><span><i className="exp" /> Despesas</span></div>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{top: 10, right: 8, left: -8, bottom: 0}} barGap={3}>
                <CartesianGrid vertical={false} stroke="#1d2c40" strokeDasharray="3 5" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{fill: '#8493aa', fontSize: 12}} dy={8} />
                <YAxis axisLine={false} tickLine={false} width={52} tick={{fill: '#8493aa', fontSize: 11}}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)} mil` : String(v))} />
                <Tooltip cursor={{fill: '#4da3ff10'}} contentStyle={{background: '#101f33', border: '1px solid #2b405d', borderRadius: 10}}
                  formatter={(v) => brl(Number(v) * 100)} labelStyle={{color: '#c9d6e8'}} />
                <Bar dataKey="Entradas" fill="#4da3ff" radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="Despesas" fill="#e6ba69" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="fin-chart-foot">
            <span>Resultado de {monthName(month).split(' de ')[0].toLowerCase()}</span>
            <b className={result >= 0 ? 'good' : 'bad'}>{brl(result)}</b>
          </div>
        </section>
      </div>

      <EntryDialog form={form} setForm={setForm} leads={leads} entries={entries} onSave={save} onDelete={remove} />
    </div>
  );
}

function EntryDialog({form, setForm, leads, entries, onSave, onDelete}: {
  form: FinanceEntry | null; setForm: (f: FinanceEntry | null) => void; leads: {id: string; name: string}[];
  entries: FinanceEntry[]; onSave: (e: FinanceEntry) => Promise<void>; onDelete: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setError(''); setConfirm(false); }, [form?.id, form === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo(() => {
    if (!form) return [];
    const used = entries.filter(e => e.kind === form.kind).map(e => e.category);
    return Array.from(new Set([...(form.kind === 'income' ? INCOME_CATS : EXPENSE_CATS), ...used]));
  }, [entries, form]);

  if (!form) return null;
  const set = (patch: Partial<FinanceEntry>) => setForm({...form, ...patch});
  const income = form.kind === 'income';
  const linked = form.lead_id ? leads.find(l => l.id === form.lead_id) : null;

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!form) return;
    if (!form.description.trim()) return setError('Informe a descrição.');
    if (!form.category.trim()) return setError('Informe o serviço ou a categoria.');
    if (!form.amount_cents || form.amount_cents <= 0) return setError('Informe um valor maior que zero.');
    setBusy(true);
    setError('');
    try {
      await onSave({
        ...form, description: form.description.trim(), category: form.category.trim(),
        client_name: form.client_name?.trim() || null, notes: form.notes?.trim() || null,
        method: form.method || null, paid_on: form.status === 'paid' ? form.paid_on || form.occurred_on : null,
      });
      setForm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    if (!form?.id) return;
    setBusy(true);
    try { await onDelete(form.id); setForm(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={o => !o && setForm(null)}>
      <DialogContent className="crm-modal fin-modal">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Editar lançamento' : income ? 'Nova entrada' : 'Nova despesa'}</DialogTitle>
          <DialogDescription>{income ? 'Serviço prestado ou valor recebido de um cliente.' : 'Gasto da empresa: ferramentas, equipe, impostos e outros.'}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={submit}>
          <div className="fin-kind" role="radiogroup" aria-label="Tipo">
            <button type="button" role="radio" aria-checked={income} className={income ? 'active income' : ''} onClick={() => set({kind: 'income'})}><ArrowUpRight size={15} /> Entrada</button>
            <button type="button" role="radio" aria-checked={!income} className={!income ? 'active expense' : ''} onClick={() => set({kind: 'expense'})}><ArrowDownRight size={15} /> Despesa</button>
          </div>
          <label className="field"><span>Descrição</span>
            <input required maxLength={300} placeholder={income ? 'Ex.: Gestão de tráfego de outubro' : 'Ex.: Assinatura da ferramenta de design'} value={form.description} onChange={e => set({description: e.target.value})} />
          </label>
          <div className="form-row">
            <label className="field"><span>{income ? 'Serviço' : 'Categoria'}</span>
              <input required maxLength={80} list="fin-cats" placeholder="Escolha ou digite" value={form.category} onChange={e => set({category: e.target.value})} />
              <datalist id="fin-cats">{suggestions.map(c => <option key={c} value={c} />)}</datalist>
            </label>
            <label className="field"><span>Valor</span>
              <span className="fin-money">
                <em>R$</em>
                <input inputMode="numeric" required placeholder="0,00" value={form.amount_cents ? plain(form.amount_cents) : ''}
                  onChange={e => set({amount_cents: Math.min(100000000000, Number(e.target.value.replace(/\D/g, '') || 0))})} aria-label="Valor em reais" />
              </span>
            </label>
          </div>
          {income && (
            <label className="field"><span>Cliente</span>
              <input maxLength={120} list="fin-leads" placeholder="Nome do cliente (ou escolha um lead do funil)" value={form.client_name || ''}
                onChange={e => {
                  const v = e.target.value;
                  const lead = leads.find(l => l.name.trim().toLowerCase() === v.trim().toLowerCase());
                  set({client_name: v, lead_id: lead ? lead.id : null});
                }} />
              <datalist id="fin-leads">{leads.slice(0, 300).map(l => <option key={l.id} value={l.name} />)}</datalist>
              {linked && <small className="fin-linked"><Link2 size={12} /> Vinculado ao lead do funil</small>}
            </label>
          )}
          <div className="form-row">
            <label className="field"><span>Data</span>
              <input type="date" required value={form.occurred_on} onChange={e => set({occurred_on: e.target.value})} />
            </label>
            <label className="field"><span>Situação</span>
              <Select value={form.status} onValueChange={v => set({status: v as 'paid' | 'pending', paid_on: v === 'paid' ? form.paid_on || form.occurred_on : null})}>
                <SelectTrigger aria-label="Situação"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">{income ? 'Recebido' : 'Pago'}</SelectItem>
                  <SelectItem value="pending">{income ? 'A receber' : 'A pagar'}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>Forma de pagamento</span>
              <Select value={form.method || 'none'} onValueChange={v => set({method: v === 'none' ? null : v})}>
                <SelectTrigger aria-label="Forma de pagamento"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Não informada</SelectItem>
                  {Object.entries(METHODS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            {form.status === 'paid' ? (
              <label className="field"><span>{income ? 'Recebido em' : 'Pago em'}</span>
                <input type="date" value={form.paid_on || form.occurred_on} onChange={e => set({paid_on: e.target.value})} />
              </label>
            ) : <span />}
          </div>
          <label className="field"><span>Observações <small>(opcional)</small></span>
            <textarea rows={2} maxLength={2000} value={form.notes || ''} onChange={e => set({notes: e.target.value})} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="fin-modal-actions">
            {form.id && (confirm
              ? <button type="button" className="button danger" disabled={busy} onClick={del}><Trash2 size={15} /> Confirmar exclusão</button>
              : <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={15} /> Excluir</button>)}
            <button type="submit" className="button primary" disabled={busy}><Check size={16} /> {busy ? 'Salvando…' : 'Salvar lançamento'}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
