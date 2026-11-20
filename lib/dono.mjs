// Dono da plataforma (Viestro): só ele vê e usa o conector do Claude, para todas as empresas.
// A lista fica na variável de ambiente CRM_DONO_EMAILS (e-mails separados por vírgula), só no
// servidor. Vazia ou ausente = ninguém é dono (o conector fica escondido de todos).
/** @param {unknown} email @param {string | undefined} lista */
export function ehDono(email, lista) {
  if (typeof email !== 'string' || !email.trim()) return false;
  const donos = String(lista || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return donos.includes(email.trim().toLowerCase());
}

// Quem não é dono não troca o modelo de IA do agente (custo da Viestro): ao salvar as configurações,
// o campo agent.model volta a ser o que já estava salvo (ou some, se não havia).
/** @param {any} novas configurações enviadas @param {any} atuais configurações salvas */
export function manterModeloDoDono(novas, atuais) {
  if (!novas || typeof novas !== 'object' || !novas.agent || typeof novas.agent !== 'object') return novas;
  const agent = {...novas.agent};
  const salvo = atuais?.agent?.model;
  if (salvo === undefined) delete agent.model; else agent.model = salvo;
  return {...novas, agent};
}
