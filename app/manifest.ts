import type {MetadataRoute} from 'next';

// Manifesto do app instalável (servido em /manifest.webmanifest). Sem service worker e sem cache
// offline: o app instalado é a mesma página do navegador e sempre busca dados novos.
// Endereços relativos: funciona igual em crm.viestroassessoria.com.br e no domínio antigo da Vercel.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Viestro CRM',
    short_name: 'Viestro',
    description: 'Leads, funil, WhatsApp e atendimento da Viestro Assessoria.',
    lang: 'pt-BR',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#091220',
    theme_color: '#091220',
    icons: [
      {src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
      {src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
      {src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
    ],
  };
}
