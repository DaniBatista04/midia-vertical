/**
 * A esteira da notícia, do material hospedado até o ar.
 *
 * É a mesma sequência do clima, com uma diferença que veio do processo e não da
 * técnica: **nada aqui começa sozinho**. A escolha da notícia é humana, então o
 * envio nasce de um clique no painel. Depois disso o caminho é igual, e o cron
 * de minuto empurra cada envio um passo por vez:
 *
 *   hospedado → (folga de propagação) → submetido → (aprovação manual) → no ar
 *
 * Cada envio tem sua própria unidade, por escolha da operação: dá para cancelar
 * ou trocar uma notícia sem encostar nas outras do mesmo dia.
 */

import {
  createOrder,
  createOrderStrategy,
  cancelOrder,
  descreverAuditoria,
  getCreativeGroup,
  getOrderDetail,
  kumaConfig,
  submitCreativeGroup,
  type KumaConfig,
} from "./client";
import {
  CIDADE_PADRAO,
  dataEmSaoPaulo,
  FREQUENCIA_PADRAO,
  inventarioEmLotes,
  nomeDoPlano,
  nomearPlano,
  resolverTelas,
} from "./agendar";
import { montarGrupoNoticia } from "./newsGroup";
import { caminhoNoticia, type EstadoNoticia } from "./noticiaEstado";
import { LEASE_SEGUNDOS } from "./estado";
import { lerJson, uploadPublico } from "../server/supabaseUpload";

/**
 * Segundos entre hospedar o material e submeter o grupo criativo.
 *
 * Medido contra a produção com o clima: o Kuma baixa o material pela URL logo
 * depois da submissão, e objeto recém-subido no Storage ainda não está
 * acessível para ele — falhou com 0s, 30s e 180s de folga, e o mesmo material
 * submetido cerca de quinze minutos depois foi aprovado. A falha aparece como
 * `502` com feedback vazio, sem dizer o motivo, então é o tipo de coisa que
 * custa horas para diagnosticar de novo.
 *
 * Aqui o custo da folga é menor que no clima: quem clicou não fica esperando na
 * tela, o cron cuida.
 */
export const GRACA_SEGUNDOS = 600;

export type PassoNoticia =
  | { estado: "aguardando-propagacao"; id: string; faltamSegundos: number }
  | { estado: "submetido"; id: string; grupoId: string }
  | { estado: "aguardando-aprovacao"; id: string; grupoId: string; auditoria: string }
  | { estado: "no-ar"; id: string; unidadeId: string; telas: number }
  | { estado: "ja-no-ar"; id: string; unidadeId: string }
  | { estado: "parado"; id: string; motivo: string };

async function gravar(estado: EstadoNoticia): Promise<void> {
  await uploadPublico({
    caminho: caminhoNoticia(estado.id),
    conteudo: Buffer.from(JSON.stringify(estado, null, 2)),
    contentType: "application/json",
  });
}

/**
 * Avança um envio em **um** passo.
 *
 * Um passo por chamada, e não o caminho todo de uma vez, porque entre os passos
 * existem esperas de minutos (a propagação) e de horas (a aprovação humana). O
 * cron chama de novo no minuto seguinte e o envio continua de onde parou.
 */
export async function avancarNoticia(
  estado: EstadoNoticia,
  opts: { cfg?: KumaConfig; baseUrl: string; log?: (m: string) => void } = { baseUrl: "" },
): Promise<PassoNoticia> {
  /*
   * A conta é conferida aqui, e não deixada para o `kumaConfig` resolver: sem
   * `KUMA_BIDDER_NEWS` ele cairia no padrão, que é a conta do clima, e a
   * notícia seria submetida na Weather sem ninguém perceber — o tipo de erro
   * que só aparece semanas depois, quando alguém estranha a lista da conta
   * errada. Faltar configuração precisa doer na primeira execução.
   */
  const conta = process.env.KUMA_BIDDER_NEWS?.trim();
  if (!conta) {
    throw new Error(
      "KUMA_BIDDER_NEWS não configurada — sem ela a notícia iria para a conta do clima.",
    );
  }
  const cfg = opts.cfg ?? kumaConfig(conta);
  const log = opts.log ?? (() => {});
  const id = estado.id;

  if (estado.erro) return { estado: "parado", id, motivo: estado.erro };

  /* ── 1. Ainda propagando? ─────────────────────────────────── */
  if (!estado.grupoId) {
    const desde = Date.parse(estado.hospedadoEm);
    const faltam = Math.ceil((desde + GRACA_SEGUNDOS * 1_000 - Date.now()) / 1_000);
    if (faltam > 0) {
      return { estado: "aguardando-propagacao", id, faltamSegundos: faltam };
    }

    const grupo = montarGrupoNoticia({
      data: new Date(`${estado.data}T00:00:00`),
      duracao: estado.duracao,
      indice: estado.indice,
      imagem32: estado.materiais[0],
      imagem25: estado.materiais[1],
      baseUrl: opts.baseUrl,
    });
    const enviado = await submitCreativeGroup(grupo, cfg);
    log(`${id}: grupo ${enviado.id} submetido — ${descreverAuditoria(enviado.audit.status)}`);
    await gravar({
      ...estado,
      grupoId: enviado.id,
      nomeGrupo: grupo.name ?? "",
      submetidoEm: new Date().toISOString(),
    });
    return { estado: "submetido", id, grupoId: enviado.id };
  }

  /* ── 2. Já está no ar? ────────────────────────────────────── */
  if (estado.unidadeId) {
    return { estado: "ja-no-ar", id, unidadeId: estado.unidadeId };
  }

  /* ── 3. A auditoria passou? ───────────────────────────────── */
  const grupo = await getCreativeGroup(estado.grupoId, cfg);
  const auditoria = descreverAuditoria(grupo.audit.status);
  if (grupo.audit.status === 1) {
    return { estado: "aguardando-aprovacao", id, grupoId: estado.grupoId, auditoria };
  }
  if (grupo.audit.status !== 3) {
    // Reprovado não melhora sozinho: registra e para de tentar, senão o cron
    // repete a mesma falha a cada minuto até alguém perceber.
    const motivo = `criativo ${auditoria}`;
    await gravar({ ...estado, erro: motivo });
    log(`${id}: ${motivo} — envio parado`);
    return { estado: "parado", id, motivo };
  }

  /* ── 4. Criar a unidade e amarrar ─────────────────────────── */
  const cidade = process.env.KUMA_CLIMA_CIDADE ?? CIDADE_PADRAO;
  const frequencia = Number(process.env.KUMA_CLIMA_FREQUENCIA ?? FREQUENCIA_PADRAO);

  const emCurso = estado.criandoEm ? Date.parse(estado.criandoEm) : 0;
  if (emCurso && Date.now() - emCurso < LEASE_SEGUNDOS * 1_000) {
    return { estado: "aguardando-aprovacao", id, grupoId: estado.grupoId, auditoria: "criação em andamento" };
  }

  /*
   * A data de veiculação é decidida **agora**, não no envio.
   *
   * A notícia não tem regra de horário: escolheu, mandou, vai ao ar. Mas entre
   * o envio e a aprovação passam minutos ou horas, e uma aprovação que atravessa
   * a meia-noite deixaria o pedido nascendo com a data de ontem — que o Kuma
   * recusa por prazo. Como o que a operação quer é "no ar assim que aprovado",
   * a data do envio serve para nomear o material, e a veiculação usa o dia
   * corrente sempre que ele já passou daquele.
   */
  const dataVeiculacao =
    estado.data < dataEmSaoPaulo(0) ? dataEmSaoPaulo(0) : estado.data;
  if (dataVeiculacao !== estado.data) {
    log(`${id}: envio é de ${estado.data} e já virou o dia — veicula em ${dataVeiculacao}`);
  }

  const telas = await resolverTelas(cidade, log);
  const disponiveis = await inventarioEmLotes(
    {
      cityId: cidade,
      targetIds: telas,
      startDate: dataVeiculacao,
      endDate: dataVeiculacao,
      durationInSecond: estado.duracao,
      frequency: frequencia,
    },
    cfg,
  );
  log(`${id}: inventário ${disponiveis.length} de ${telas.length} tela(s)`);
  if (!disponiveis.length) {
    const motivo = `nenhuma tela com inventário para ${dataVeiculacao} a ${frequencia} exibições/dia`;
    await gravar({ ...estado, erro: motivo });
    return { estado: "parado", id, motivo };
  }

  await gravar({ ...estado, criandoEm: new Date().toISOString() });

  const unidadeId = await createOrder(
    {
      cityId: cidade,
      targetIds: disponiveis,
      goalLocationNum: disponiveis.length,
      startDate: dataVeiculacao,
      endDate: dataVeiculacao,
      durationInSecond: estado.duracao,
      frequency: frequencia,
    },
    cfg,
  );
  log(`${id}: unidade ${unidadeId} criada`);

  // Unidade sem criativo trava inventário e não exibe nada.
  try {
    await createOrderStrategy(unidadeId, [estado.grupoId], cfg);
  } catch (e) {
    log(`${id}: amarramento falhou — cancelando a unidade ${unidadeId}`);
    await cancelOrder(unidadeId, cfg).catch((err) =>
      console.error(`[noticia] cancelamento também falhou, cancele no portal: ${err}`),
    );
    await gravar({ ...estado, criandoEm: undefined }).catch(() => {});
    throw e;
  }

  // O nome do plano leva a data e o índice: com várias notícias no mesmo dia,
  // só a data não distingue uma da outra na lista do portal.
  await nomearPlano(
    unidadeId,
    dataVeiculacao,
    cfg,
    log,
    `${nomeDoPlano(dataVeiculacao)} N${estado.indice}`,
  );

  const detalhe = await getOrderDetail(unidadeId, cfg);
  const travadas = detalhe.orderItems[0]?.reservedLocationIds?.length ?? 0;
  await gravar({
    ...estado,
    unidadeId,
    agendadoEm: new Date().toISOString(),
    telas: travadas,
    criandoEm: undefined,
  });
  log(`${id}: no ar em ${travadas} tela(s)`);

  return { estado: "no-ar", id, unidadeId, telas: travadas };
}

/** Uma linha legível por passo, para log e para a tela. */
export function descreverPasso(p: PassoNoticia): string {
  switch (p.estado) {
    case "aguardando-propagacao":
      return `${p.id}: material propagando — faltam ${p.faltamSegundos}s para submeter`;
    case "submetido":
      return `${p.id}: grupo ${p.grupoId} submetido, aguardando aprovação no portal`;
    case "aguardando-aprovacao":
      return `${p.id}: ${p.auditoria}`;
    case "no-ar":
      return `${p.id}: no ar na unidade ${p.unidadeId}, ${p.telas} tela(s)`;
    case "ja-no-ar":
      return `${p.id}: já estava no ar na unidade ${p.unidadeId}`;
    case "parado":
      return `${p.id}: parado — ${p.motivo}`;
  }
}

/** Lê um envio pelo id. */
export async function lerNoticia(id: string): Promise<EstadoNoticia | null> {
  return lerJson<EstadoNoticia>(caminhoNoticia(id));
}
