import {serviceClient, sessionClient} from '@/lib/supabase/server';
import {body, reply, sameOrigin} from '@/lib/http';
import {ehDono} from '@/lib/dono.mjs';
import {chaveDoCaminho, corpoDoModelo, linkDeConexao, numeroDaLista} from '@/lib/wasapflow.mjs';
import {modelosDaEquipe} from '@/lib/relatorio-diario.mjs';
import {CAMPOS_CONTA, modelosDaPonte, ponte, type Conta} from '@/lib/wa-provedor';
import {syncTemplatesDaConta} from '@/lib/whatsapp-worker';

export const dynamic = 'force-dynamic';

// WasapFlow Bridge: SÓ o dono da plataforma (CRM_DONO_EMAILS). Conectar um número (o portal do WasapFlow
// não tem botão de conectar: o link sai daqui, com a chave de parceiro só no servidor) e criar os modelos
// da equipe (alerta_atendimento e relatorio_diario). Nada disso é visível para os clientes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function dono() {
  const db = await sessionClient();
  const {data: {user}} = await db.auth.getUser();
  if (!user) return reply({error: 'Faça login para continuar.'}, 401);
  if (!ehDono(user.email, process.env.CRM_DONO_EMAILS)) return reply({error: 'Disponível só para a Viestro.'}, 403);
  return null;
}
const erroDaPonte = (j: any, status: number) => String(j?.error?.code || `http_${status}`).slice(0, 40);

export async function GET(req: Request) {
  try {
    const negado = await dono();
    if (negado) return negado;
    const db = serviceClient();
    const [empresas, contas] = await Promise.all([
      db.from('crm_companies').select('id,name').order('name'),
      db.from('wa_accounts').select('id,company_id,provider,phone_e164,display_name,connection_status,provider_alert_code').order('created_at'),
    ]);
    if (empresas.error || contas.error) throw empresas.error || contas.error;
    const chave = chaveDoCaminho(process.env.WF_WEBHOOK_SECRET);
    const origem = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    return reply({
      configurado: Boolean(process.env.WF_PARTNER_KEY && chave),
      webhook: chave ? `${origem}/api/webhooks/wasapflow/${chave}` : null,
      empresas: (empresas.data || []).map(e => ({id: e.id, nome: e.name,
        numeros: (contas.data || []).filter(c => c.company_id === e.id).map(({company_id: _, ...c}) => c)})),
    });
  } catch {
    return reply({error: 'Não foi possível carregar o WasapFlow.'}, 500);
  }
}

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return reply({error: 'Origem inválida'}, 403);
    const negado = await dono();
    if (negado) return negado;
    if (!process.env.WF_PARTNER_KEY) return reply({error: 'Cadastre WF_PARTNER_KEY na Vercel e republique.'}, 503);
    const b = await body(req, 5000);
    if (!UUID.test(String(b.empresa || ''))) return reply({error: 'Empresa inválida'}, 400);
    const db = serviceClient();
    const {data: empresa} = await db.from('crm_companies').select('id,name').eq('id', b.empresa).maybeSingle();
    if (!empresa) return reply({error: 'Empresa não encontrada'}, 404);

    if (b.action === 'conectar') {
      // state = id da empresa: volta no popup e é conferido na tela antes de registrar.
      const res = await ponte('/connect/session', {method: 'POST', body: {display_name: String(empresa.name).slice(0, 120), state: empresa.id}});
      const j: any = await res.json().catch(() => null);
      const url = res.ok ? linkDeConexao(j) : null;
      if (!url) return reply({error: `O WasapFlow não gerou o link (${erroDaPonte(j, res.status)}).`}, 502);
      return reply({url});
    }

    if (b.action === 'registrar') {
      // Confere no WasapFlow que o número foi mesmo conectado na nossa conta de parceiro.
      const res = await ponte('/clients?limit=500');
      const j: any = await res.json().catch(() => null);
      if (!res.ok) return reply({error: `O WasapFlow não respondeu (${erroDaPonte(j, res.status)}).`}, 502);
      const numero = numeroDaLista(j, String(b.waba_id || ''), String(b.phone_number_id || ''));
      if (!numero) return reply({error: 'Número não encontrado na conta do WasapFlow. Tente conectar de novo.'}, 404);
      const {data: id, error} = await db.rpc('wa_account_use_wasapflow', {p_company: empresa.id, p_phone_e164: numero.phone_e164,
        p_waba_id: numero.waba_id, p_phone_number_id: numero.phone_number_id, p_display: numero.display_name});
      if (error) return reply({error: error.code === 'P0001' ? error.message : 'Não foi possível registrar o número.'}, 400);
      const {data: conta} = await db.from('wa_accounts').select(CAMPOS_CONTA).eq('id', id as string).single();
      if (conta) await syncTemplatesDaConta(conta as Conta, true).catch(() => 0);
      return reply({ok: true, numero: numero.phone_e164});
    }

    if (b.action === 'modelos') {
      // Cria alerta_atendimento e relatorio_diario (UTILITY, pt_BR) em cada número do WasapFlow da empresa,
      // só os que ainda não existem. A Meta aprova em até 24 h; o CRM sincroniza pelo webhook.
      const {data: contas} = await db.from('wa_accounts').select(CAMPOS_CONTA + ',phone_e164')
        .eq('company_id', empresa.id).eq('provider', 'wasapflow');
      if (!contas?.length) return reply({error: 'Esta empresa ainda não tem número no WasapFlow.'}, 400);
      const resultado = [];
      for (const conta of contas as unknown as (Conta & {phone_e164: string})[]) {
        const existentes = await modelosDaPonte(db, conta);
        if (!existentes) { resultado.push({numero: conta.phone_e164, erro: 'modelos indisponíveis'}); continue; }
        const criados: string[] = [], jaExistiam: string[] = [], erros: string[] = [];
        for (const m of modelosDaEquipe()) {
          if (existentes.some((t: {name: string; language: string}) => t.name === m.name && t.language === m.language)) { jaExistiam.push(m.name); continue; }
          const r = await ponte('/templates', {method: 'POST', conta, body: corpoDoModelo(m)});
          const j: any = await r.json().catch(() => null);
          if (r.ok && j?.success !== false) criados.push(m.name);
          else erros.push(`${m.name}: ${erroDaPonte(j, r.status)}${j?.error?.meta_message ? ` (${String(j.error.meta_message).slice(0, 120)})` : ''}`);
        }
        await syncTemplatesDaConta(conta, true).catch(() => 0);
        resultado.push({numero: conta.phone_e164, criados, jaExistiam, erros});
      }
      return reply({ok: true, resultado});
    }
    return reply({error: 'Ação inválida'}, 400);
  } catch {
    return reply({error: 'Não foi possível concluir agora.'}, 500);
  }
}
