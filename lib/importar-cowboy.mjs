// Importação das planilhas exportadas do CRM Cowboy do Marketing (Contatos + Funil de vendas).
// Funções puras: rodam no navegador (antes de enviar) e nos testes. Nada aqui grava no banco.

const LIMITE_NOME = 120;
const LIMITE_NOTAS = 2000;

export function texto(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v));
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s === '-' ? '' : s;
}

const chave = (s) => texto(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Telefone brasileiro em +55DDNNNNNNNNN. Celular sem o 9 (formato antigo do WhatsApp) ganha o 9.
export function normalizarTelefone(v) {
  let d = texto(v).replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!d.startsWith('55')) return '';
  if (d.length === 12 && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  if (d.length !== 12 && d.length !== 13) return '';
  return '+' + d;
}

// "🟢 Em contato" -> etapa da empresa com o mesmo nome; "Vendido" -> "Ganho".
export function etapaCowboy(status, etapas) {
  const limpo = chave(texto(status).replace(/^[^\p{L}\p{N}]+/u, ''));
  if (!limpo) return null;
  const alvo = limpo === 'vendido' ? 'ganho' : limpo;
  return etapas.find((e) => chave(e) === alvo) || null;
}

// Primeira linha = títulos. Devolve objetos { título: valor }.
export function linhasPorTitulo(linhas) {
  const [titulos = [], ...resto] = linhas || [];
  const nomes = titulos.map((t) => texto(t));
  return resto
    .filter((l) => l && l.some((c) => texto(c) !== ''))
    .map((l) => Object.fromEntries(nomes.map((n, i) => [n, l[i]])));
}

export function confereColunas(contatos, funil) {
  const falta = [];
  const cc = Object.keys(contatos[0] || {}), cf = Object.keys(funil[0] || {});
  for (const c of ['Nome', 'Telefone']) if (!cc.includes(c)) falta.push('Contatos: ' + c);
  for (const c of ['Contato', 'Status']) if (!cf.includes(c)) falta.push('Funil: ' + c);
  return falta;
}

function dataIso(v) {
  const s = texto(v);
  const t = Date.parse(s);
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(t) ? new Date(t).toISOString() : '';
}

// Junta contato (telefone) e oportunidade (etapa) pelo nome, como o Cowboy faz.
export function montarImportacao(contatos, funil, etapas) {
  const avisos = { semNome: 0, semTelefone: 0, nomesRepetidos: [], etapasDesconhecidas: {} };
  const porNome = new Map();
  for (const c of contatos) {
    const k = chave(c['Nome']);
    if (!k) { avisos.semNome++; continue; }
    porNome.set(k, [...(porNome.get(k) || []), c]);
  }
  const repetidos = new Set([...porNome].filter(([, l]) => l.length > 1).map(([k]) => k));

  // Uma oportunidade por contato: fica a mais recente.
  const oportunidade = new Map();
  for (const f of funil) {
    const k = chave(f['Contato']);
    if (!k) { avisos.semNome++; continue; }
    const atual = oportunidade.get(k);
    if (!atual || dataIso(f['Created At']) > dataIso(atual['Created At'])) oportunidade.set(k, f);
  }

  const leads = [];
  const nomes = new Set([...porNome.keys(), ...oportunidade.keys()]);
  for (const k of nomes) {
    if (repetidos.has(k)) { avisos.nomesRepetidos.push(texto(porNome.get(k)[0]['Nome'])); continue; }
    const c = porNome.get(k)?.[0], f = oportunidade.get(k);
    const nome = texto(c?.['Nome'] || f?.['Contato']).slice(0, LIMITE_NOME);
    const telefone = normalizarTelefone(c?.['Telefone']);
    if (!telefone) avisos.semTelefone++;
    let etapa = etapas[0];
    if (f) {
      const e = etapaCowboy(f['Status'], etapas);
      if (e) etapa = e;
      else {
        const s = texto(f['Status']).replace(/^[^\p{L}\p{N}]+/u, '') || '(vazio)';
        avisos.etapasDesconhecidas[s] = (avisos.etapasDesconhecidas[s] || 0) + 1;
      }
    }
    const notas = [texto(f?.['Observação']), texto(f?.['Prioridade']) && 'Prioridade: ' + texto(f['Prioridade'])]
      .filter(Boolean).concat('Importado do Cowboy').join(' · ').slice(0, LIMITE_NOTAS);
    leads.push({
      name: nome,
      phone: telefone,
      stage: etapa,
      owner: texto(f?.['Assignee']).replace(/\s*\(.*\)\s*$/, '').slice(0, 60),
      notes: notas,
      created: dataIso(f?.['Created At']) || dataIso(c?.['Created At']),
      importId: 'cowboy:' + texto(f?.['id'] || c?.['id']).slice(0, 60),
    });
  }
  const porEtapa = Object.fromEntries(etapas.map((e) => [e, leads.filter((l) => l.stage === e).length]));
  return { leads, avisos, porEtapa };
}

export function emLotes(lista, tamanho = 200) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}
