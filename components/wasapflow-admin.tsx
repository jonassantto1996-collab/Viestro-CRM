'use client';
import {useState} from 'react';
import {Copy, LockKeyhole, PlugZap, Send} from 'lucide-react';
import {toast} from 'sonner';

// Cartão em Configurações, só para o dono da plataforma (Viestro): números no WasapFlow Bridge.
// "Conectar número" abre o popup do WasapFlow (o link é gerado no servidor; a chave de parceiro nunca
// chega ao navegador) e, quando o número conecta, o CRM passa a usar o WasapFlow só nesse número.
type Numero = {id: string; provider: string; phone_e164: string; display_name?: string | null; connection_status: string; provider_alert_code?: string | null};
type Empresa = {id: string; nome: string; numeros: Numero[]};
const ORIGEM = 'https://officialapi.wasapflow.com';
const FORNECEDOR: Record<string, string> = {wasapflow: 'WasapFlow', easycoexistence: 'EasyCoexistence', meta_cloud: 'Meta'};

export default function WasapflowAdmin() {
  const [dados, setDados] = useState<{configurado: boolean; webhook: string | null; empresas: Empresa[]} | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  async function carregar() {
    setOcupado('carregar');
    try {
      const r = await fetch('/api/wasapflow', {cache: 'no-store'});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Não foi possível carregar.');
      setDados(j);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível carregar.'); }
    finally { setOcupado(null); }
  }

  async function post(corpo: Record<string, unknown>) {
    const r = await fetch('/api/wasapflow', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(corpo)});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Não foi possível concluir.');
    return j;
  }

  async function conectar(e: Empresa) {
    setOcupado(e.id);
    try {
      const {url} = await post({action: 'conectar', empresa: e.id});
      const popup = window.open(url, 'wasapflow-connect', 'width=720,height=820');
      if (!popup) throw new Error('O navegador bloqueou a janela. Libere pop-ups para este site.');
      await new Promise<void>((resolve, reject) => {
        const fim = (fn: () => void) => { window.removeEventListener('message', ouvir); clearInterval(fechada); fn(); };
        const ouvir = async (ev: MessageEvent) => {
          if (ev.origin !== ORIGEM) return;
          const d = ev.data || {};
          if (d.state && d.state !== e.id) return; // resposta de outra empresa: ignora
          if (d.type === 'WASAPFLOW_CONNECT_SUCCESS') {
            try {
              const r = await post({action: 'registrar', empresa: e.id, waba_id: d.waba_id, phone_number_id: d.phone_number_id});
              toast.success(`Número ${r.numero} agora usa o WasapFlow em ${e.nome}.`);
              fim(resolve);
            } catch (err) { fim(() => reject(err)); }
          } else if (d.type === 'WASAPFLOW_CONNECT_CANCEL') fim(() => reject(new Error('Conexão cancelada.')));
          else if (d.type === 'WASAPFLOW_CONNECT_ERROR') fim(() => reject(new Error(`O WasapFlow recusou: ${String(d.message || d.code || 'erro')}`)));
        };
        window.addEventListener('message', ouvir);
        // Janela fechada sem resposta: não fica "conectando" para sempre.
        const fechada = setInterval(() => { if (popup.closed) { clearInterval(fechada); setTimeout(() => fim(() => reject(new Error('Janela fechada antes de concluir.'))), 1500); } }, 1000);
      });
      await carregar();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível conectar.'); }
    finally { setOcupado(null); }
  }

  async function criarModelos(e: Empresa) {
    setOcupado(e.id + ':modelos');
    try {
      const {resultado} = await post({action: 'modelos', empresa: e.id});
      for (const r of resultado || []) {
        if (r.erro || r.erros?.length) toast.error(`${r.numero}: ${r.erro || r.erros.join('; ')}`);
        else toast.success(`${r.numero}: ${r.criados?.length ? `criados ${r.criados.join(', ')} (a Meta aprova em até 24 h)` : 'os modelos já existiam'}`);
      }
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível criar os modelos.'); }
    finally { setOcupado(null); }
  }

  async function copiar(texto: string) {
    try { await navigator.clipboard.writeText(texto); toast.success('Endereço copiado.'); }
    catch { toast.error('Não consegui copiar. Selecione e copie manualmente.'); }
  }

  return <section className="panel settings-panel">
    <div className="panel-heading"><h2>WhatsApp pelo WasapFlow</h2><PlugZap size={19}/></div>
    <p>Só você (Viestro) vê este cartão. Cada número usa um fornecedor; conectar aqui troca só o número escolhido para o WasapFlow.</p>
    {!dados && <button className="button secondary" disabled={ocupado === 'carregar'} onClick={carregar}><LockKeyhole size={16}/>{ocupado === 'carregar' ? 'Carregando...' : 'Mostrar números e fornecedores'}</button>}
    {dados && <div className="hook-result">
      {!dados.configurado && <p>Cadastre WF_PARTNER_KEY e WF_WEBHOOK_SECRET na Vercel (sensíveis) e republique.</p>}
      {dados.webhook && <div className="connector-item">
        <strong>Webhook URL (portal do WasapFlow › Integration › Webhook)</strong>
        <code>{dados.webhook}</code>
        <button className="button secondary" onClick={() => copiar(dados.webhook!)}><Copy size={16}/>Copiar endereço</button>
      </div>}
      {dados.empresas.map(e => <div key={e.id} className="connector-item">
        <strong>{e.nome}</strong>
        {e.numeros.length ? <ul className="muted">{e.numeros.map(n => <li key={n.id}>{n.display_name || n.phone_e164} · {FORNECEDOR[n.provider] || n.provider}{n.connection_status !== 'connected' ? ` · ${n.connection_status}` : ''}{n.provider_alert_code ? ` · aviso: ${n.provider_alert_code}` : ''}</li>)}</ul> : <p className="muted">Sem número.</p>}
        <div className="form-row">
          <button className="button secondary" disabled={!dados.configurado || !!ocupado} onClick={() => conectar(e)}><PlugZap size={16}/>{ocupado === e.id ? 'Conectando...' : 'Conectar número'}</button>
          {e.numeros.some(n => n.provider === 'wasapflow') && <button className="button secondary" disabled={!!ocupado} onClick={() => criarModelos(e)}><Send size={16}/>{ocupado === e.id + ':modelos' ? 'Criando...' : 'Criar modelos da equipe'}</button>}
        </div>
      </div>)}
      <p className="muted" style={{marginTop: 12}}>O endereço do webhook funciona como senha. Não compartilhe.</p>
    </div>}
  </section>;
}
