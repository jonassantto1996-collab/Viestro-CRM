'use client';
import {useEffect, useState} from 'react';
import {Bot, PenLine, ShieldCheck, Sparkles} from 'lucide-react';
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

const EXEMPLO_VENDA = `Antes de oferecer, entenda: o que o cliente procura e para quando.
Faça uma pergunta por vez e mostre que entendeu o que ele disse.
Se perguntar o preço logo de cara: explique do que depende e convide para a avaliação gratuita.
Se disser "vou pensar": pergunte se ficou alguma dúvida, sem insistir.
Próximo passo: sempre convidar para agendar a avaliação.`;

// Configuração do agente de atendimento do WhatsApp (Configurações). Salva em settings.agent.
export default function AgentSettings({company, admin, demo, onSave}: {company: any; admin: boolean; demo: boolean; onSave: (c: any) => Promise<void> | void}) {
  const [a, setA] = useState<any>({...AGENTE_PADRAO, ...(company.settings?.agent || {})});
  const [salvando, setSalvando] = useState(false);
  useEffect(() => setA({...AGENTE_PADRAO, ...(company.settings?.agent || {})}), [company]);
  const set = (patch: any) => setA((x: any) => ({...x, ...patch}));

  async function salvar() {
    const agente = {...a, name: a.name.trim(), knowledge: a.knowledge.trim(), sales: (a.sales || '').trim(), handoff: a.handoff.trim(), funnel: (a.funnel || '').trim()};
    if (!agenteValido(agente)) {
      toast.error(agente.enabled && agente.knowledge.length < 30 ? 'Escreva a base de conhecimento antes de ativar o agente.'
        : agente.office_start >= agente.office_end ? 'O horário de fechar precisa ser depois do de abrir.' : 'Revise o nome (até 40 letras) e os textos do agente.');
      return;
    }
    setSalvando(true);
    try { await onSave({...company, settings: {...company.settings, agent: agente}}); } finally { setSalvando(false); }
  }

  return <section className="panel settings-panel agent-settings">
    <div className="panel-heading"><h2>Agente de atendimento</h2><Sparkles size={19}/></div>
    <p>O agente lê a conversa do WhatsApp e responde usando só o que estiver na base de conhecimento.</p>
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
    <label className="field"><span>Como vender</span>
      <textarea disabled={!admin} rows={7} maxLength={4000} placeholder={EXEMPLO_VENDA} value={a.sales || ''} onChange={e => set({sales: e.target.value})}/>
      <small>O jeito da empresa conduzir a conversa: o que perguntar, como responder objeções e qual o próximo passo. Preços e fatos ficam na base de conhecimento. Opcional. {(a.sales || '').length.toLocaleString('pt-BR')}/4.000</small>
    </label>
    <label className="field"><span>Quando chamar a equipe</span>
      <textarea disabled={!admin} rows={3} maxLength={1500} placeholder="Ex.: dor ou urgência, orçamento de implante, pedido de desconto." value={a.handoff} onChange={e => set({handoff: e.target.value})}/>
      <small>Reclamações, pedidos para falar com uma pessoa e assuntos de saúde já vão sempre para a equipe.</small>
    </label>
    <label className="field"><span>Quando mover no funil</span>
      <textarea disabled={!admin} rows={4} maxLength={2000} placeholder={`Ex.:\nEm contato: o cliente respondeu.\nEm Negociação: falou de entrada, parcelas ou financiamento.\nVisita Agendada: confirmou o dia de vir à loja.`} value={a.funnel || ''} onChange={e => set({funnel: e.target.value})}/>
      <small>Só no modo automático. O agente só avança o lead entre as etapas do funil ({(company?.settings?.stages || []).filter((e: string) => e !== 'Ganho' && e !== 'Perdido').join(', ') || 'sem etapas'}); Ganho e Perdido ficam com a equipe. Vazio = o agente não mexe no funil. {(a.funnel || '').length.toLocaleString('pt-BR')}/2.000</small>
    </label>
    <div className="field"><span>Como o agente trabalha</span>
      <div className="agent-modes" role="radiogroup" aria-label="Modo do agente">
        <button type="button" role="radio" aria-checked={a.mode === 'sugestao'} disabled={!admin} className={'agent-mode-card' + (a.mode === 'sugestao' ? ' on' : '')} onClick={() => set({mode: 'sugestao'})}>
          <PenLine size={17}/><strong>Sugestão</strong><span>O agente escreve a resposta e a equipe revisa e envia.</span>
        </button>
        <button type="button" role="radio" aria-checked={a.mode === 'automatico'} disabled={!admin} className={'agent-mode-card' + (a.mode === 'automatico' ? ' on' : '')} onClick={() => set({mode: 'automatico'})}>
          <Bot size={17}/><strong>Automático</strong><span>O agente responde sozinho as dúvidas e passa para a equipe o que precisar.</span>
        </button>
      </div>
    </div>
    {a.mode === 'automatico' && <div className="agent-auto">
      <label className="field"><span>Quando responder sozinho</span>
        <select className="agent-select" disabled={!admin} value={a.auto_when} onChange={e => set({auto_when: e.target.value})}>
          <option value="sempre">Sempre, a qualquer hora</option>
          <option value="fora_expediente">Só fora do expediente</option>
        </select>
      </label>
      {a.auto_when === 'fora_expediente' && <div className="form-row agent-office">
        <label className="field"><span>Dias de expediente</span>
          <select className="agent-select" disabled={!admin} value={a.office_days} onChange={e => set({office_days: e.target.value})}>
            <option value="seg-sex">Segunda a sexta</option><option value="seg-sab">Segunda a sábado</option>
          </select>
        </label>
        <label className="field"><span>Abre às</span><input type="time" disabled={!admin} value={a.office_start} onChange={e => set({office_start: e.target.value})}/></label>
        <label className="field"><span>Fecha às</span><input type="time" disabled={!admin} value={a.office_end} onChange={e => set({office_end: e.target.value})}/></label>
      </div>}
      <ul className="agent-safety">
        <li><ShieldCheck size={14}/>Responde só com o que está na base de conhecimento.</li>
        <li><ShieldCheck size={14}/>Espera o cliente terminar de escrever antes de responder.</li>
        <li><ShieldCheck size={14}/>Fica em silêncio por 12 horas na conversa em que alguém da equipe responder, pelo celular ou pelo CRM.</li>
        <li><ShieldCheck size={14}/>Passa para a equipe (marca como Pendente) reclamações, assuntos de saúde, pedidos de desconto e o que estiver nas regras acima. No máximo 10 respostas por conversa por dia; depois disso, passa para a equipe.</li>
        <li><ShieldCheck size={14}/>Dá para pausar o agente em qualquer conversa, na própria conversa.</li>
      </ul>
    </div>}
    {admin && <button className="button primary" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : demo ? 'Salvar na demonstração' : 'Salvar agente'}</button>}
  </section>;
}
