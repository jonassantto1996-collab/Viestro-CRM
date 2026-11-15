// Protocolo MCP (JSON-RPC 2.0) mínimo para o conector do Claude, sem estado.
// Só leitura: initialize, ping, tools/list e tools/call.

export const VERSOES = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ErroFerramenta extends Error {}

const erro = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

export async function responder(msg, {ferramentas, servidor, instrucoes, registrar = () => {}}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return erro(msg && typeof msg === 'object' && 'id' in msg ? msg.id : null, -32600, 'Requisição inválida');
  }
  const notificacao = !('id' in msg);
  if (notificacao) return null; // notifications/initialized e afins não têm resposta
  const {id, method, params = {}} = msg;

  if (method === 'initialize') {
    const pedida = params?.protocolVersion;
    return {jsonrpc: '2.0', id, result: {
      protocolVersion: VERSOES.includes(pedida) ? pedida : VERSOES[0],
      capabilities: {tools: {listChanged: false}},
      serverInfo: servidor,
      instructions: instrucoes,
    }};
  }
  if (method === 'ping') return {jsonrpc: '2.0', id, result: {}};
  if (method === 'tools/list') {
    return {jsonrpc: '2.0', id, result: {tools: ferramentas.map(({name, title, description, inputSchema}) => ({
      name, title, description, inputSchema, annotations: {title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    }))}};
  }
  if (method === 'tools/call') {
    const f = ferramentas.find(x => x.name === params?.name);
    if (!f) return erro(id, -32602, `Ferramenta desconhecida: ${String(params?.name).slice(0, 60)}`);
    const args = params?.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return erro(id, -32602, 'Argumentos inválidos');
    try {
      const resultado = await f.run(args);
      registrar(f.name, true);
      const texto = typeof resultado === 'string' ? resultado : JSON.stringify(resultado, null, 1);
      return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: texto}], isError: false}};
    } catch (e) {
      registrar(f.name, false);
      const mensagem = e instanceof ErroFerramenta ? e.message : 'Não foi possível consultar o CRM agora. Tente de novo.';
      return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: mensagem}], isError: true}};
    }
  }
  return erro(id, -32601, 'Método não suportado');
}

// Aceita uma mensagem ou um lote; devolve o corpo da resposta (ou null quando só havia notificações).
export async function responderCorpo(corpo, opcoes) {
  if (Array.isArray(corpo)) {
    if (!corpo.length || corpo.length > 20) return erro(null, -32600, 'Lote inválido');
    const respostas = (await Promise.all(corpo.map(m => responder(m, opcoes)))).filter(Boolean);
    return respostas.length ? respostas : null;
  }
  return responder(corpo, opcoes);
}
