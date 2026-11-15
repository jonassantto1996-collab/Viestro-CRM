'use client';
import {useEffect, useState} from 'react';
import {Sparkles} from 'lucide-react';
import {toast} from 'sonner';
import {Switch} from '@/components/ui/switch';
import {AGENTE_PADRAO, agenteValido} from '@/lib/agente.mjs';

const EXEMPLO = `Serviços e preços:
- Consulta de avaliação: gratuita
- Limpeza: R$ 150,00

Horário: segunda a sexta, 8h às 18h; sábado, 8h às 12h.
Endereço: Rua ..., nº ..., bairro ..., Tucumã-PA.
Formas de pagamento: Pix, cartão em até 3x.
Convênios: ...
Perguntas frequentes: ...`;

// Configuração do agente de atendimento do WhatsApp (Configurações). Salva em settings.agent.
export default function AgentSettings({company, admin, demo, onSave}: {company: any; admin: boolean; demo: boolean; onSave: (c: any) => Promise<void> | void}) {
  const [a, setA] = useState<any>({...AGENTE_PADRAO, ...(company.settings?.agent || {})});
  const [salvando, setSalvando] = useState(false);
  useEffect(() => setA({...AGENTE_PADRAO, ...(company.settings?.agent || {})}), [company]);
  const set = (patch: any) => setA((x: any) => ({...x, ...patch}));

  async function salvar() {
    const agente = {...a, name: a.name.trim(), knowledge: a.knowledge.trim(), handoff: a.handoff.trim()};
    if (!agenteValido(agente)) {
      toast.error(agente.enabled && agente.knowledge.length < 30 ? 'Escreva a base de conhecimento antes de ativar o agente.' : 'Revise o nome (até 40 letras) e os textos do agente.');
      return;
    }
    setSalvando(true);
    try { await onSave({...company, settings: {...company.settings, agent: agente}}); } finally { setSalvando(false); }
  }

  return <section className="panel settings-panel agent-settings">
    <div className="panel-heading"><h2>Agente de atendimento</h2><Sparkles size={19}/></div>
    <p>O agente lê a conversa do WhatsApp e escreve a resposta usando só o que estiver na base de conhecimento. Você revisa e envia com um clique.</p>
    <label className="agent-toggle"><Switch checked={a.enabled} disabled={!admin} onCheckedChange={(v: boolean) => set({enabled: v})}/><span>{a.enabled ? 'Agente ativado' : 'Agente desativado'}</span></label>
    <div className="form-row">
      <label className="field"><span>Nome do assistente</span><input disabled={!admin} maxLength={40} value={a.name} onChange={e => set({name: e.target.value})}/></label>
      <label className="field"><span>Tom de voz</span>
        <select className="agent-select" disabled={!admin} value={a.tone} onChange={e => set({tone: e.target.value})}>
          <option value="acolhedor">Acolhedor</option><option value="profissional">Profissional</option><option value="descontraido">Descontraído</option>
        </select>
      </label>
    </div>
    <label className="field"><span>Base de conhecimento</span>
      <textarea disabled={!admin} rows={11} maxLength={8000} placeholder={EXEMPLO} value={a.knowledge} onChange={e => set({knowledge: e.target.value})}/>
      <small>Serviços, preços, horários, endereço, pagamento e perguntas frequentes. O agente nunca inventa o que não estiver aqui. {a.knowledge.length.toLocaleString('pt-BR')}/8.000</small>
    </label>
    <label className="field"><span>Quando chamar a equipe</span>
      <textarea disabled={!admin} rows={3} maxLength={1500} placeholder="Ex.: dor ou urgência, orçamento de implante, pedido de desconto." value={a.handoff} onChange={e => set({handoff: e.target.value})}/>
      <small>Reclamações, pedidos para falar com uma pessoa e assuntos de saúde já vão sempre para a equipe.</small>
    </label>
    <div className="agent-mode"><strong>Modo: sugestão</strong><span>O agente escreve, a equipe revisa e envia. Resposta automática: em breve.</span></div>
    {admin && <button className="button primary" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : demo ? 'Salvar na demonstração' : 'Salvar agente'}</button>}
  </section>;
}
