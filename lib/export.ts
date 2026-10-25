// Exportação para planilha (CSV no padrão brasileiro: ponto e vírgula e acentos preservados).
// Abre direto no Excel e importa no Google Planilhas.
export type Cell = string | number | null | undefined;

const NUMBER = /^-?\d+(,\d+)?$/;
const safe = (v: Cell) => {
  const s = String(v ?? '');
  // evita fórmulas maliciosas na planilha, sem estragar números negativos
  const guarded = typeof v === 'number' || NUMBER.test(s) ? s : s.replace(/^[=+@-]/, "'$&");
  return '"' + guarded.replaceAll('"', '""') + '"';
};

export function downloadCsv(filename: string, columns: string[], rows: Cell[][]) {
  const text = '\uFEFF' + [columns, ...rows].map(r => r.map(safe).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], {type: 'text/csv;charset=utf-8;'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Número com vírgula decimal e sem separador de milhar: o Excel em português reconhece como número. */
export const sheetNumber = (n: number) => (Number(n) || 0).toFixed(2).replace('.', ',');
/** Data AAAA-MM-DD para DD/MM/AAAA. */
export const sheetDate = (iso?: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
