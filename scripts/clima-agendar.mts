/**
 * Segunda fase do clima: cria a unidade do dia e amarra o grupo criativo.
 *
 * Ela existe separada da fase das 23h por uma razão da própria API: a
 * estratégia só aceita grupo **aprovado** — com auditoria pendente a resposta é
 * `-12`. Como a aprovação é manual, no portal, o agendamento roda em intervalos
 * e só age quando encontra o grupo do dia já aprovado. É o mesmo desenho do
 * `poll-creatives` do Mural: ninguém precisa avisar a automação, ela percebe.
 *
 *   npm run clima:agendar                 agenda o clima de amanhã, se aprovado
 *   npm run clima:agendar -- --data=...   um dia específico
 *   npm run clima:agendar -- --simular    faz tudo menos criar e amarrar
 *
 * Sair com código 0 sem agendar é normal: significa "ainda não aprovado".
 * Código 1 é problema de verdade — criativo reprovado, inventário insuficiente
 * ou falha de chamada.
 *
 * Variáveis, além das do Kuma:
 *   KUMA_CLIMA_CIDADE     cityId; padrão 6003 (São Paulo)
 *   KUMA_CLIMA_PREDIOS    buildingIds separados por vírgula, ou
 *   KUMA_CLIMA_TELAS      locationIds separados por vírgula
 *   KUMA_CLIMA_FREQUENCIA exibições/dia por tela; padrão 600 (múltiplo de 300)
 */

import {
  cancelOrder,
  createOrder,
  createOrderStrategy,
  descreverAuditoria,
  getCreativeGroup,
  getOrderDetail,
  getValidLocations,
  inquireSufficientTargets,
  kumaConfig,
} from "../src/lib/kuma/client";
import { caminhoEstado, type EstadoDoDia } from "../src/lib/kuma/estado";
import { lerJson, uploadPublico } from "../src/lib/server/supabaseUpload";

const arg = (nome: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
const SIMULAR = process.argv.includes("--simular");

const CIDADE = process.env.KUMA_CLIMA_CIDADE ?? "6003";
const FREQUENCIA = Number(process.env.KUMA_CLIMA_FREQUENCIA ?? 600);

function log(msg: string) {
  console.log(`[agendar] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Datas candidatas, em ordem de urgência.
 *
 * A fase 1 roda às 23h e submete o clima do dia seguinte. Esta fase roda da
 * meia-noite ao meio-dia, quando aquele "dia seguinte" já virou **hoje** — daí
 * hoje vir primeiro. Amanhã entra depois para cobrir o caso de esta fase rodar
 * antes da meia-noite, ou de um envio manual adiantado.
 */
function datasCandidatas(): string[] {
  const explicita = arg("data");
  if (explicita) return [explicita];
  const hoje = new Date();
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  return [iso(hoje), iso(amanha)];
}

/**
 * Resolve as telas alvo. Exige configuração explícita: um pedido consome
 * inventário de tela física, então "todas as telas da cidade" nunca é padrão.
 */
async function resolverTelas(): Promise<string[]> {
  const telas = (process.env.KUMA_CLIMA_TELAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (telas.length) return telas;

  const predios = (process.env.KUMA_CLIMA_PREDIOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!predios.length) {
    throw new Error("defina KUMA_CLIMA_TELAS ou KUMA_CLIMA_PREDIOS — o alvo do pedido não tem padrão");
  }
  const locais = await getValidLocations(CIDADE, predios);
  log(`${predios.length} prédio(s) → ${locais.length} tela(s)`);
  return locais.map((l) => l.locationId);
}

/** Devolve true quando agendou; false quando não havia nada a fazer nesta data. */
async function processar(data: string, cfg: ReturnType<typeof kumaConfig>): Promise<boolean> {
  const caminho = caminhoEstado(data);
  const estado = await lerJson<EstadoDoDia>(caminho);
  if (!estado) return false;
  if (estado.unidadeId) {
    log(`${data}: já agendado na unidade ${estado.unidadeId}`);
    return false;
  }
  log(`${data}: grupo ${estado.grupoId} · cidade ${CIDADE} · ${FREQUENCIA} exibições/dia`);

  const grupo = await getCreativeGroup(estado.grupoId, cfg);
  log(`auditoria: ${descreverAuditoria(grupo.audit.status)}`);

  if (grupo.audit.status === 1) {
    log("aguardando a aprovação no portal — o próximo ciclo tenta de novo");
    return false;
  }
  if (grupo.audit.status !== 3) {
    throw new Error(
      `criativo de ${data} não está aprovado (${descreverAuditoria(grupo.audit.status)}) — ` +
        "regenere o clima com --indice maior",
    );
  }

  const telas = await resolverTelas();
  const disponiveis = await inquireSufficientTargets({
    cityId: CIDADE,
    targetIds: telas,
    startDate: data,
    endDate: data,
    durationInSecond: estado.duracao,
    frequency: FREQUENCIA,
  }, cfg);
  log(`inventário: ${disponiveis.length} de ${telas.length} tela(s) disponíveis`);
  if (!disponiveis.length) {
    throw new Error(`nenhuma tela com inventário para ${data} a ${FREQUENCIA} exibições/dia`);
  }

  if (SIMULAR) {
    log(`simulação: criaria unidade para ${data} em ${disponiveis.length} tela(s) e amarraria ${estado.grupoId}`);
    return true;
  }

  const unidadeId = await createOrder({
    cityId: CIDADE,
    targetIds: disponiveis,
    goalLocationNum: disponiveis.length,
    startDate: data,
    endDate: data,
    durationInSecond: estado.duracao,
    frequency: FREQUENCIA,
  }, cfg);
  log(`unidade criada: ${unidadeId}`);

  // Unidade sem criativo trava inventário e não exibe nada. Se o amarramento
  // falhar, desfaz o pedido em vez de deixar o lixo ocupando tela.
  try {
    await createOrderStrategy(unidadeId, [estado.grupoId], cfg);
  } catch (e) {
    log(`amarramento falhou — cancelando a unidade ${unidadeId}`);
    await cancelOrder(unidadeId, cfg).catch((err) =>
      console.error(`[agendar] cancelamento também falhou, cancele no portal: ${err}`),
    );
    throw e;
  }
  log(`grupo ${estado.grupoId} amarrado à unidade`);

  const detalhe = await getOrderDetail(unidadeId, cfg);
  const travadas = detalhe.orderItems[0]?.reservedLocationIds?.length ?? 0;
  log(`unidade ${detalhe.orderStatus} · ${detalhe.startDate} → ${detalhe.endDate} · ${travadas} tela(s) travada(s)`);

  await uploadPublico({
    caminho,
    conteudo: Buffer.from(
      JSON.stringify(
        { ...estado, unidadeId, agendadoEm: new Date().toISOString(), telas: travadas },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  log("estado do dia atualizado");
  return true;
}

async function main() {
  const cfg = kumaConfig();
  const datas = datasCandidatas();
  for (const data of datas) {
    if (await processar(data, cfg)) return;
  }
  log(`nada a agendar em ${datas.join(" nem ")}`);
}

main().catch((e) => {
  console.error(`[agendar] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
