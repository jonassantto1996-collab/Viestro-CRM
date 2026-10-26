import type {NextConfig} from 'next';
// Cache de compilação do Turbopack desligado no build: em 25/10/2026 a Vercel reaproveitou um CSS antigo
// (estilos novos não foram publicados). O build fica alguns segundos mais lento, mas sempre completo.
const config:NextConfig={poweredByHeader:false,experimental:{turbopackFileSystemCacheForBuild:false},async headers(){return [{source:'/(.*)',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'},{key:'Referrer-Policy',value:'strict-origin-when-cross-origin'}]}]}};
export default config;
