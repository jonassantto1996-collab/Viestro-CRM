'use client';
import {useState} from 'react';
import {FileSpreadsheet, Upload} from 'lucide-react';
import {toast} from 'sonner';
import {linhasPorTitulo, confereColunas, montarImportacao, emLotes} from '@/lib/importar-cowboy.mjs';

type Previa = ReturnType<typeof montarImportacao>;

async function lerPlanilha(arquivo: File) {
  const {readSheet} = await import('read-excel-file/browser');
  return linhasPorTitulo(await readSheet(arquivo) as unknown[][]);
}

// Cartão em Configurações (só admin): importa as planilhas exportadas do CRM Cowboy (Contatos + Funil de vendas).
export default function ImportPlanilha({stages}: {stages: string[]}) {
  const [contatos, setContatos] = useState<File | null>(null);
  const [funil, setFunil] = useState<File | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<{inserted: number; skipped: number} | null>(null);

  async function ler() {
    if (!contatos || !funil) return toast.error('Escolha as duas planilhas: Contatos e Funil de vendas.');
    setOcupado(true); setPrevia(null); setResultado(null);
    try {
      const [c, f] = await Promise.all([lerPlanilha(contatos), lerPlanilha(funil)]);
      const falta = confereColunas(c, f);
      if (falta.length) throw new Error('Colunas não encontradas: ' + falta.join(', ') + '. Confira se escolheu cada planilha no campo certo.');
      const p = montarImportacao(c, f, stages);
      if (!p.leads.length) throw new Error('Nenhum lead encontrado nas planilhas.');
      setPrevia(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não consegui ler as planilhas.');
    } finally { setOcupado(false); }
  }

  async function importar() {
    if (!previa) return;
    setOcupado(true);
    const total = {inserted: 0, skipped: 0};
    try {
      for (const lote of emLotes(previa.leads, 200)) {
        const r = await fetch('/api/crm/importar', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({rows: lote})});
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Não foi possível importar.');
        total.inserted += j.inserted; total.skipped += j.skipped;
      }
      setResultado(total); setPrevia(null);
      toast.success(`${total.inserted} leads importados.`);
    } catch (e) {
      if (total.inserted) setResultado(total);
      toast.error((e instanceof Error ? e.message : 'Não foi possível importar.') + (total.inserted ? ` ${total.inserted} já foram gravados; importar de novo não duplica.` : ''));
    } finally { setOcupado(false); }
  }

  const desconhecidas = previa ? Object.entries(previa.avisos.etapasDesconhecidas) : [];

  return <section className="panel settings-panel">
    <div className="panel-heading"><h2>Importar leads do Cowboy</h2><FileSpreadsheet size={19}/></div>
    <p>No Cowboy, exporte <b>Contatos</b> e <b>Funil de vendas</b> (botão ⋯ › Exportar Registros) e escolha os dois arquivos abaixo. Nada é gravado antes da sua confirmação, e importar de novo não duplica.</p>
    <div className="import-files">
      <label>Planilha de Contatos<input type="file" accept=".xlsx" disabled={ocupado} onChange={(e) => {setContatos(e.target.files?.[0] || null); setPrevia(null);}}/></label>
      <label>Planilha do Funil de vendas<input type="file" accept=".xlsx" disabled={ocupado} onChange={(e) => {setFunil(e.target.files?.[0] || null); setPrevia(null);}}/></label>
    </div>
    {!previa && <button className="button secondary" disabled={ocupado || !contatos || !funil} onClick={ler}><Upload size={16}/>{ocupado ? 'Lendo...' : 'Ler planilhas'}</button>}

    {previa && <div className="hook-result">
      <p><b>{previa.leads.length} leads prontos para importar</b></p>
      <ul className="import-list">{Object.entries(previa.porEtapa).filter(([, n]) => n).map(([e, n]) => <li key={e}>{e}: <b>{n}</b></li>)}</ul>
      {previa.avisos.semTelefone > 0 && <p className="muted">{previa.avisos.semTelefone} sem telefone (entram, mas o agente não consegue falar com eles).</p>}
      {previa.avisos.semNome > 0 && <p className="muted">{previa.avisos.semNome} linhas sem nome foram ignoradas.</p>}
      {desconhecidas.length > 0 && <p className="muted">Etapas que não existem aqui (entram em “{stages[0]}”): {desconhecidas.map(([s, n]) => `${s} (${n})`).join(', ')}. Para manter, crie a etapa em Funil acima antes de importar.</p>}
      {previa.avisos.nomesRepetidos.length > 0 && <p className="muted">Nomes repetidos nos Contatos, não importados (cadastre manualmente): {previa.avisos.nomesRepetidos.join(', ')}.</p>}
      <div className="import-actions">
        <button className="button" disabled={ocupado} onClick={importar}>{ocupado ? 'Importando...' : `Importar ${previa.leads.length} leads`}</button>
        <button className="button secondary" disabled={ocupado} onClick={() => setPrevia(null)}>Cancelar</button>
      </div>
    </div>}

    {resultado && <div className="hook-result">
      <p><b>{resultado.inserted} leads importados.</b>{resultado.skipped > 0 && ` ${resultado.skipped} já existiam e foram pulados.`}</p>
      <button className="button secondary" onClick={() => window.location.reload()}>Atualizar o CRM</button>
    </div>}
  </section>;
}
