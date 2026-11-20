'use client';
import {useState} from 'react';
import {Bot, Copy, LockKeyhole} from 'lucide-react';
import {toast} from 'sonner';

// Cartão em Configurações, só para o dono da plataforma (Viestro): endereço do conector do Claude
// de cada empresa. Clientes não veem este cartão e a API recusa o pedido deles.
type Conector = {empresa: string; url: string};
export default function ClaudeConnector() {
  const [conectores, setConectores] = useState<Conector[] | null>(null);
  const [carregando, setCarregando] = useState(false);

  async function mostrar() {
    setCarregando(true);
    try {
      const r = await fetch('/api/conector-claude', {cache: 'no-store'});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Não foi possível gerar o endereço.');
      setConectores(Array.isArray(j.conectores) ? j.conectores : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível gerar o endereço.');
    } finally {
      setCarregando(false);
    }
  }

  async function copiar(url: string, empresa: string) {
    try { await navigator.clipboard.writeText(url); toast.success(`Endereço de ${empresa} copiado.`); }
    catch { toast.error('Não consegui copiar. Selecione o endereço e copie manualmente.'); }
  }

  return <section className="panel settings-panel">
    <div className="panel-heading"><h2>Conectar ao Claude</h2><Bot size={19}/></div>
    <p>Só você (Viestro) vê este cartão. Consulte leads, funil, tarefas, WhatsApp e financeiro de cada empresa conversando com o Claude. O conector só lê os dados: não envia mensagens nem altera nada.</p>
    {!conectores && <button className="button secondary" disabled={carregando} onClick={mostrar}><LockKeyhole size={16}/>{carregando ? 'Gerando...' : 'Mostrar endereços dos conectores'}</button>}
    {conectores && <div className="hook-result">
      <p>No Claude: Configurações › Conectores › Adicionar conector personalizado. Cole o endereço da empresa:</p>
      {conectores.map(c => <div key={c.url} className="connector-item">
        <strong>{c.empresa}</strong>
        <code>{c.url}</code>
        <button className="button secondary" onClick={() => copiar(c.url, c.empresa)}><Copy size={16}/>Copiar endereço</button>
      </div>)}
      <p className="muted" style={{marginTop: 12}}>Cada endereço funciona como uma senha. Não compartilhe com clientes.</p>
    </div>}
  </section>;
}
