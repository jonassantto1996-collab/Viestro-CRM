'use client';
import {AlertTriangle} from 'lucide-react';
import {AVISO_GRAVE, textoDoAviso} from '@/lib/wasapflow-avisos.mjs';

export type AvisoNumero = {id: string; phone_e164?: string | null; display_name?: string | null; provider_alert_code: string; provider_alert_at?: string | null};

// Faixa de aviso do número (pagamento, bloqueio, desconexão, agente da Meta). Não bloqueia nada:
// a caixa de entrada continua funcionando; só explica por que envios podem falhar.
export function AvisosDosNumeros({avisos, compacto = false}: {avisos: AvisoNumero[] | null | undefined; compacto?: boolean}) {
  const lista = (avisos || []).filter(a => a?.provider_alert_code);
  if (!lista.length) return null;
  return (
    <div className={'number-alerts' + (compacto ? ' is-compact' : '')} role="status">
      {lista.map(a => (
        <p key={a.id} className={AVISO_GRAVE.has(a.provider_alert_code) ? 'is-grave' : ''}>
          <AlertTriangle size={15} />
          <span><b>{a.display_name || a.phone_e164 || 'Número do WhatsApp'}:</b> {textoDoAviso(a.provider_alert_code)}</span>
        </p>
      ))}
    </div>
  );
}
