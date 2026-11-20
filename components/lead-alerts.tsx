'use client';
import {useEffect, useRef, useState} from 'react';
import {BellRing} from 'lucide-react';
import {toast} from 'sonner';

// Alerta do atendente: quando o agente passa uma conversa para a equipe, o CRM avisa
// (som + notificação do computador + aviso na tela). Lead quente vem com 🔥.
// O que já foi avisado fica guardado neste navegador, para não tocar de novo.
export type Alerta = {id: string; title: string; owner: string; hot: boolean; created: string};

const CHAVE = 'viestro:alertas-vistos';
const chaveDo = (a: Alerta) => a.id + (a.hot ? ':quente' : ''); // ficou quente depois: avisa de novo

function lerVistos(): Set<string> | null {
  try { const v = localStorage.getItem(CHAVE); return v ? new Set(JSON.parse(v)) : null; } catch { return null; }
}
function gravarVistos(v: Set<string>) {
  try { localStorage.setItem(CHAVE, JSON.stringify([...v].slice(-200))); } catch {}
}

// Som curto gerado no navegador (sem arquivo). Lead quente toca duas vezes.
function tocar(quente: boolean) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const notas = quente ? [880, 1175, 880, 1175] : [880, 1175];
    notas.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.17);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {}
}

export function textoDoAlerta(a: Alerta) {
  const quem = a.title.replace(/^🔥\s*/, '').replace(/^Atender\s+/, '').replace(/\s*\(passado pelo agente\)$/, '');
  return a.hot ? `🔥 Lead quente para ${a.owner}: ${quem}` : `Atendimento esperando ${a.owner}: ${quem}`;
}

export function useAlertasDeLead(alertas: Alerta[] | null, aoChegar: () => void, aoAbrir: () => void) {
  const primeiro = useRef(true);
  useEffect(() => {
    if (!alertas) return;
    let vistos = lerVistos();
    const novos = alertas.filter(a => !vistos?.has(chaveDo(a)));
    // Primeira vez neste computador: não dispara alarme para o que já estava aberto.
    if (!vistos) { gravarVistos(new Set(alertas.map(chaveDo))); primeiro.current = false; return; }
    primeiro.current = false;
    if (!novos.length) return;
    novos.forEach(a => vistos!.add(chaveDo(a)));
    gravarVistos(vistos);
    const quente = novos.some(a => a.hot);
    tocar(quente);
    for (const a of novos.slice(0, 3)) {
      toast(textoDoAlerta(a), {duration: 20_000, action: {label: 'Ver', onClick: aoAbrir}});
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          const n = new Notification(a.hot ? '🔥 Lead quente' : 'Atendimento esperando', {body: textoDoAlerta(a), tag: a.id});
          n.onclick = () => { window.focus(); aoAbrir(); n.close(); };
        }
      } catch {}
    }
    aoChegar();
  }, [alertas]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Botão para ligar as notificações do computador (o navegador só pergunta depois de um clique).
export function AtivarAvisos() {
  const [estado, setEstado] = useState<string>('granted');
  useEffect(() => { setEstado('Notification' in window ? Notification.permission : 'unsupported'); }, []);
  if (estado !== 'default') return null;
  return <button type="button" className="button secondary lead-alert-enable" onClick={async () => {
    try { setEstado(await Notification.requestPermission()); tocar(false); } catch { setEstado('unsupported'); }
  }}><BellRing size={16}/>Ativar avisos neste computador</button>;
}
