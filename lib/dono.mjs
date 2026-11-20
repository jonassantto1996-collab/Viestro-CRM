// Dono da plataforma (Viestro): só ele vê e usa o conector do Claude, para todas as empresas.
// A lista fica na variável de ambiente CRM_DONO_EMAILS (e-mails separados por vírgula), só no
// servidor. Vazia ou ausente = ninguém é dono (o conector fica escondido de todos).
/** @param {unknown} email @param {string | undefined} lista */
export function ehDono(email, lista) {
  if (typeof email !== 'string' || !email.trim()) return false;
  const donos = String(lista || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return donos.includes(email.trim().toLowerCase());
}
