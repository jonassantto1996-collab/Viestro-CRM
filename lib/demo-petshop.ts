// Demonstração para pet shop (acessada por /?demo=petshop). Dados 100% fictícios.
import {initialSettings} from './demo';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const date = (ms: number) => iso(ms).slice(0, 10);

export function petshopData() {
  const now = Date.now();
  const stages = initialSettings.stages;
  const people: [string, string, string, string, number, number, number, string][] = [
    // nome, pet/serviço, origem, etapa, valor, nota, dias atrás, responsável
    ['Maria Souza', 'Mel · Shih-tzu · Pacote banho mensal', 'Instagram', stages[1], 320, 75, 0, 'Ana'],
    ['João Pereira', 'Rex · Labrador · Ração assinatura', 'WhatsApp', stages[3], 260, 100, 1, 'Jonas'],
    ['Carla Lima', 'Luna · Gata · Vacina V5', 'Google', stages[2], 150, 75, 1, 'Ana'],
    ['Ana Beatriz Rocha', 'Thor · Golden · Tosa higiênica', 'Indicação', stages[0], 90, 25, 2, 'Ana'],
    ['Pedro Alves', 'Bob · Vira-lata · Banho e tosa', 'Instagram', stages[4], 120, 100, 2, 'Jonas'],
    ['Fernanda Dias', 'Nina · Poodle · Pacote banho mensal', 'WhatsApp', stages[4], 320, 100, 3, 'Ana'],
    ['Ricardo Gomes', 'Max · Pastor · Hospedagem 5 dias', 'Google', stages[3], 450, 75, 3, 'Jonas'],
    ['Juliana Martins', 'Pipoca · Spitz · Banho e tosa', 'Instagram', stages[1], 110, 50, 4, 'Ana'],
    ['Lucas Andrade', 'Zeus · Rottweiler · Ração assinatura', 'Indicação', stages[2], 290, 75, 5, 'Jonas'],
    ['Patrícia Nunes', 'Belinha · Yorkshire · Pacote banho mensal', 'WhatsApp', stages[4], 280, 100, 5, 'Ana'],
    ['Gustavo Ribeiro', 'Simba · Gato · Consulta', 'Google', stages[5], 150, 25, 6, 'Jonas'],
    ['Camila Teixeira', 'Kiara · Lhasa · Tosa completa', 'Instagram', stages[3], 140, 75, 7, 'Ana'],
    ['Rafael Costa', 'Duque · Bulldog · Banho medicamentoso', 'WhatsApp', stages[1], 130, 50, 8, 'Jonas'],
    ['Larissa Melo', 'Amora · Maltês · Pacote banho mensal', 'Indicação', stages[0], 300, 25, 9, 'Ana'],
    ['Diego Barros', 'Tobby · Beagle · Hospedagem fim de semana', 'Google', stages[2], 220, 75, 10, 'Jonas'],
    ['Aline Carvalho', 'Frida · Dachshund · Banho e tosa', 'Instagram', stages[4], 100, 100, 11, 'Ana'],
    ['Marcos Vieira', 'Bidu · Schnauzer · Tosa completa', 'WhatsApp', stages[1], 150, 50, 12, 'Jonas'],
    ['Sofia Ramos', 'Lua · Gata · Vacina antirrábica', 'Indicação', stages[0], 80, 25, 13, 'Ana'],
  ];
  const leads = people.map(([name, business, source, stage, value, score, ago, owner], i) => ({
    id: 'p' + i, name, business, email: '', phone: '', source, campaignId: source === 'Instagram' ? 'c1' : source === 'Google' ? 'c2' : '',
    stage, value, score, checks: Array.from({length: 4}, (_, j) => j < score / 25), owner,
    notes: 'Cliente fictício da demonstração do pet shop.', created: iso(now - ago * DAY - (i % 5) * 3_600_000), utm_campaign: '',
  }));
  return {
    user: null,
    company: {name: 'Pet Shop Amigo Fiel', niche: 'Pet shop', settings: {...initialSettings, criteria: ['Tem pet cadastrado', 'Serviço definido', 'Data combinada', 'Aceitou o valor']}},
    members: [{id: 'm1', name: 'Jonas', email: '', role: 'admin'}, {id: 'm2', name: 'Ana', email: '', role: 'member'}],
    leads,
    campaigns: [
      {id: 'c1', name: 'Instagram · Banho e tosa do mês', channel: 'Meta Ads', spend: 680, status: 'Ativa', start: date(now - 30 * DAY)},
      {id: 'c2', name: 'Google · Pet shop perto de mim', channel: 'Google Ads', spend: 420, status: 'Ativa', start: date(now - 30 * DAY)},
    ],
    tasks: [
      {id: 't1', title: 'Confirmar banho da Mel amanhã às 9h', leadId: 'p0', owner: 'Ana', due: date(now), done: false},
      {id: 't2', title: 'Enviar valor da assinatura de ração para o João', leadId: 'p1', owner: 'Jonas', due: date(now), done: false},
      {id: 't3', title: 'Lembrar vacina da Luna', leadId: 'p2', owner: 'Ana', due: date(now - DAY), done: false},
      {id: 't4', title: 'Reservar hospedagem do Max', leadId: 'p6', owner: 'Jonas', due: date(now + DAY), done: false},
    ],
    activity: [
      {id: 'a1', text: 'Pedro Alves fechou banho e tosa', created: iso(now - 3_600_000)},
      {id: 'a2', text: 'Nova oportunidade: Maria Souza', created: iso(now - 7_200_000)},
    ],
  };
}

/** Lançamentos fictícios do financeiro de um pet shop. */
export function petshopFinance() {
  const out: Record<string, unknown>[] = [];
  const now = new Date();
  for (let m = 5; m >= 0; m--) {
    const y = now.getFullYear(), mo = now.getMonth() - m;
    const d = (day: number) => {
      const x = new Date(y, mo, Math.min(day, 28));
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const current = m === 0;
    const g = 1 + (5 - m) * 0.06;
    const add = (kind: string, day: number, description: string, category: string, reais: number, method: string, pending = false, client: string | null = null) => {
      const occurred = d(day);
      if (current && occurred > d(now.getDate())) return;
      out.push({id: `pet-fin-${out.length}`, kind, occurred_on: occurred, description, category, client_name: client, lead_id: null,
        amount_cents: Math.round(reais * g) * 100, method, status: pending ? 'pending' : 'paid', paid_on: pending ? null : occurred, notes: null});
    };
    add('income', 7, 'Banhos e tosas da semana', 'Banho e tosa', 2350, 'pix');
    add('income', 14, 'Banhos e tosas da semana', 'Banho e tosa', 2480, 'pix');
    add('income', 21, 'Banhos e tosas da semana', 'Banho e tosa', 2210, 'cartao_debito');
    add('income', 10, 'Venda de rações e petiscos', 'Ração e produtos', 3900, 'cartao_credito');
    add('income', 24, 'Venda de rações e petiscos', 'Ração e produtos', 3450, 'pix');
    add('income', 18, 'Consultas e vacinas', 'Clínica', 1600, 'pix', current, 'Clínica parceira');
    if (m % 2 === 0) add('income', 26, 'Hospedagem de fim de semana', 'Hospedagem', 880, 'dinheiro');
    add('income', 27, 'Pacotes de banho mensais', 'Pacote mensal', 1920, 'pix', current);
    add('expense', 5, 'Compra de ração (fornecedor)', 'Estoque', 5200, 'boleto');
    add('expense', 6, 'Aluguel do ponto', 'Aluguel e estrutura', 2500, 'transferencia');
    add('expense', 8, 'Shampoos e produtos de banho', 'Insumos', 640, 'cartao_credito');
    add('expense', 15, 'Salário do tosador', 'Equipe', 2200, 'pix', current);
    add('expense', 20, 'Energia e água', 'Aluguel e estrutura', 610, 'boleto', current);
  }
  return out;
}
