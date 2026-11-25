// Textos dos avisos de número mostrados no CRM (códigos em wa_accounts.provider_alert_code).
// Sem dependência de servidor: usado pela tela. Testado em tests/wasapflow.test.mjs.
export const TEXTO_AVISO = {
  wf_pagamento: 'O WasapFlow recusou envios por pagamento pendente. Confira a cobrança no portal do WasapFlow; as mensagens recebidas continuam chegando.',
  wf_suspenso: 'A conta de parceiro no WasapFlow está suspensa. Fale com o suporte do WasapFlow.',
  wf_chave: 'A chave do WasapFlow (WF_PARTNER_KEY) foi recusada. Confira a variável na Vercel e republique.',
  wf_numero_nao_registrado: 'O WasapFlow não reconhece este número. Conecte o número de novo em Configurações.',
  wf_desconectado: 'O WhatsApp Business do celular foi reinstalado ou trocado de aparelho. A Meta costuma reconectar sozinha em minutos; até lá os envios falham.',
  wf_acesso_removido: 'O acesso do WasapFlow a este número foi removido. É preciso conectar o número de novo (mesma conta e mesmo número).',
  wf_conta_restrita: 'A Meta restringiu ou desativou a conta do WhatsApp. Veja os detalhes no WhatsApp Manager.',
  wf_agente_meta: 'O agente de IA da própria Meta está respondendo os clientes, não o seu agente. Para retomar, desligue em WhatsApp Manager → Ferramentas da conta → Business Agent. O chat manual continua funcionando.',
};
// Pagamento e bloqueio são vermelhos; o resto é amarelo (nada quebrou, mas alguém precisa agir).
export const AVISO_GRAVE = new Set(['wf_pagamento', 'wf_suspenso', 'wf_chave', 'wf_acesso_removido', 'wf_conta_restrita']);

export function textoDoAviso(code) {
  return TEXTO_AVISO[code] || 'O fornecedor do WhatsApp avisou um problema neste número. Veja os registros da Vercel.';
}
