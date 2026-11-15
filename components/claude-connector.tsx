'use client';
import {useState} from 'react';
import {Bot, Copy, LockKeyhole} from 'lucide-react';
import {toast} from 'sonner';

// Cartão em Configurações: entrega ao administrador o endereço do conector do Claude.
export default function ClaudeConnector() {
  const [url, setUrl] = useState('');
  const [carregando, setCarregando] = useState(false);

  async function mostrar() {
    setCarregando(true);
    try {
      const r = await fetch('/api/conector-claude', {cache: 'no-store'});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Não foi possível gerar o endereço.');
      setUrl(j.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível gerar o endereço.');
    } finally {
      setCarregando(false);
    }
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(url); toast.success('Endereço copiado.'); }
    catch { toast.error('Não consegui copiar. Selecione o endereço e copie manualmente.'); }
  }

  return <section className="panel settings-panel">
    <div className="panel-heading"><h2>Conectar ao Claude</h2><Bot size={19}/></div>
    <p>Consulte leads, funil, tarefas, WhatsApp e financeiro conversando com o Claude. O conector só lê os dados: não envia mensagens nem altera nada.</p>
    {!url && <button className="button secondary" disabled={carregando} onClick={mostrar}><LockKeyhole size={16}/>{carregando ? 'Gerando...' : 'Mostrar endereço do conector'}</button>}
    {url && <div className="hook-result">
      <p>No Claude: Configurações › Conectores › Adicionar conector personalizado. Cole este endereço:</p>
      <code>{url}</code>
      <button className="button secondary" onClick={copiar}><Copy size={16}/>Copiar endereço</button>
      <p className="muted" style={{marginTop: 12}}>Este endereço funciona como uma senha. Não compartilhe.</p>
    </div>}
  </section>;
}
