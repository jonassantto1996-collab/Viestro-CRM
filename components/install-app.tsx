'use client';
import {useEffect, useState} from 'react';
import {Download} from 'lucide-react';

// Botão discreto "Instalar aplicativo": só aparece quando o navegador oferece a instalação
// (evento beforeinstallprompt, Chrome/Edge no computador e Android). No iPhone a instalação é
// pelo Safari › Compartilhar › Adicionar à Tela de Início. Sem service worker e sem cache offline.
type PedidoInstalacao = Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>};

export default function InstallApp() {
  const [pedido, setPedido] = useState<PedidoInstalacao | null>(null);

  useEffect(() => {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return; // já aberto como aplicativo
    const oferecer = (e: Event) => { e.preventDefault(); setPedido(e as PedidoInstalacao); };
    const instalado = () => setPedido(null);
    window.addEventListener('beforeinstallprompt', oferecer);
    window.addEventListener('appinstalled', instalado);
    return () => { window.removeEventListener('beforeinstallprompt', oferecer); window.removeEventListener('appinstalled', instalado); };
  }, []);

  if (!pedido) return null;
  return <button type="button" className="install-app" title="Instalar o Viestro CRM como aplicativo neste aparelho"
    onClick={async () => {
      try { await pedido.prompt(); await pedido.userChoice; } catch {}
      setPedido(null); // o navegador só deixa pedir uma vez por evento
    }}>
    <Download size={15}/><span>Instalar aplicativo</span>
  </button>;
}
