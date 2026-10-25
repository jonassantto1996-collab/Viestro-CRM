// Lançamentos fictícios da demonstração (agência de marketing). Nenhum dado real.
type Entry = {
  id: string; kind: 'income' | 'expense'; occurred_on: string; description: string; category: string;
  client_name: string | null; lead_id: string | null; amount_cents: number; method: string | null;
  status: 'paid' | 'pending'; paid_on: string | null; notes: string | null;
};

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function financeDemo(): Entry[] {
  const out: Entry[] = [];
  const now = new Date();
  const clients = ['Clínica Horizonte', 'Studio Forma', 'Casa & Design', 'Comércio Local', 'Pet Shop Amigo'];
  for (let m = 5; m >= 0; m--) {
    const base = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const at = (day: number) => iso(new Date(base.getFullYear(), base.getMonth(), Math.min(day, 28)));
    const current = m === 0;
    const growth = 1 + (5 - m) * 0.08;
    const push = (e: Omit<Entry, 'id' | 'paid_on' | 'lead_id' | 'notes'> & {notes?: string}) => {
      out.push({...e, id: `demo-fin-${out.length}`, lead_id: null, notes: e.notes || null, paid_on: e.status === 'paid' ? e.occurred_on : null});
    };
    clients.slice(0, 3 + (m % 3)).forEach((c, i) => push({
      kind: 'income', occurred_on: at(5 + i * 3), description: `Mensalidade de gestão de tráfego · ${c}`, category: 'Gestão de tráfego',
      client_name: c, amount_cents: Math.round((1500 + i * 400) * growth) * 100, method: 'pix',
      status: current && i >= 2 ? 'pending' : 'paid',
    }));
    if (m % 2 === 0) push({
      kind: 'income', occurred_on: at(18), description: 'Site institucional com página de captação', category: 'Site ou landing page',
      client_name: clients[(m + 1) % clients.length], amount_cents: 380000, method: 'transferencia', status: current ? 'pending' : 'paid',
    });
    if (m % 3 === 1) push({
      kind: 'income', occurred_on: at(22), description: 'Implantação de CRM com WhatsApp', category: 'Sistema sob medida',
      client_name: clients[(m + 2) % clients.length], amount_cents: 520000, method: 'boleto', status: 'paid',
    });
    push({kind: 'expense', occurred_on: at(3), description: 'Ferramentas (design, hospedagem e banco de dados)', category: 'Ferramentas e assinaturas',
      client_name: null, amount_cents: 64000, method: 'cartao_credito', status: 'paid'});
    push({kind: 'expense', occurred_on: at(10), description: 'Freelancer de vídeo', category: 'Equipe',
      client_name: null, amount_cents: 90000, method: 'pix', status: current ? 'pending' : 'paid'});
    push({kind: 'expense', occurred_on: at(20), description: 'Simples Nacional', category: 'Impostos',
      client_name: null, amount_cents: Math.round(42000 * growth), method: 'boleto', status: current ? 'pending' : 'paid'});
  }
  return out.filter(e => e.occurred_on <= iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
}
