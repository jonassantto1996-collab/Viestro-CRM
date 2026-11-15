// Endereço secreto do conector do Claude (MCP), um por empresa.
// A chave não fica guardada em lugar nenhum: é calculada a partir da chave secreta do
// servidor (SUPABASE_SECRET_KEY) e do id da empresa. Trocar CRM_MCP_ROTACAO na Vercel
// invalida todos os endereços já entregues (use se um endereço vazar).
import {createHmac, timingSafeEqual} from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chaveConector(segredo, empresaId, rotacao = '') {
  if (!segredo || segredo.length < 20) throw new Error('Segredo do servidor ausente.');
  if (!UUID.test(empresaId)) throw new Error('Empresa inválida.');
  const assinatura = createHmac('sha256', segredo).update(`viestro-crm:mcp:v1:${empresaId.toLowerCase()}:${rotacao}`).digest('base64url');
  return `${empresaId.toLowerCase()}.${assinatura}`;
}

// Devolve o id da empresa se o token do endereço for válido; senão null.
export function conferirChave(segredo, token, rotacao = '') {
  if (!segredo || segredo.length < 20 || typeof token !== 'string' || token.length > 200) return null;
  const ponto = token.indexOf('.');
  if (ponto < 0) return null;
  const empresaId = token.slice(0, ponto);
  if (!UUID.test(empresaId)) return null;
  const esperado = Buffer.from(chaveConector(segredo, empresaId, rotacao));
  const recebido = Buffer.from(token.toLowerCase().slice(0, ponto) + token.slice(ponto));
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
  return empresaId.toLowerCase();
}
