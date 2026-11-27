// Leitura em páginas: o Supabase (PostgREST) devolve no máximo 1.000 linhas por consulta, mesmo com
// .limit(5000). Sem paginar, o que passa de 1.000 some sem erro. Testado em tests/paginar.test.mjs.

/**
 * Lê até `max` linhas em páginas de `pagina`. `montar(de, ate)` devolve a consulta já com .range(de, ate)
 * (ordem estável, senão as páginas se sobrepõem). Para quando uma página vem incompleta.
 * @template T
 * @param {(de: number, ate: number) => PromiseLike<{data: T[] | null, error: any}>} montar
 * @param {{pagina?: number, max?: number}} [opcoes]
 * @returns {Promise<T[]>}
 */
export async function lerTudo(montar, {pagina = 1000, max = 5000} = {}) {
  const linhas = [];
  for (let de = 0; de < max; de += pagina) {
    const ate = Math.min(de + pagina, max) - 1;
    const {data, error} = await montar(de, ate);
    if (error) throw error;
    const lote = data || [];
    linhas.push(...lote);
    if (lote.length < ate - de + 1) break;
  }
  return linhas;
}
