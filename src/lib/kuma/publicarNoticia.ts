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
 * Cada envio tem seu próprio grupo criativo — é o que passa pela Análise
 * Criativa individualmente —, mas a **unidade é uma por dia**: todos os grupos
 * do mesmo dia são amarrados nela e ficam juntos na estratégia, e é o Kuma que
 * reparte as exibições entre eles — uma notícia por exibição, em todas as
 * janelas do dia. Ver `noticiaPlano.ts` para a evidência disso, para a regra do
 * padding que a Brato exige e para o limite de notícias por dia.
 */

import {
  createOrder,
  createOrderStrategy,
  cancelOrder,
  descreverAuditoria,
  getCreativeGroup,
  getOrderDetail,
  KumaError,
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
import {
  caminhoPlanoNoticias,
  gruposParaEstrategia,
  mesmaEstrategia,
  slotsDaFrequencia,
  type PlanoNoticias,
} from "./noticiaPlano";
import { caminhoNoticia, type EstadoNoticia } from "./noticiaEstado";
import { LEASE_SEGUNDOS } from "./estado";
import { apagar, lerJson, uploadPublico } from "../server/supabaseUpload";

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

async function gravarPlano(plano: PlanoNoticias): Promise<void> {
  // `noAr` é resquício do rodízio que existiu entre 01 e 03/09/2026: um plano
  // gravado naquela época ainda traz o campo, e o spread de quem edita o
  // registro o levaria de volta ao arquivo para sempre.
  const limpo: PlanoNoticias & { noAr?: string } = { ...plano };
  delete limpo.noAr;
  await uploadPublico({
    caminho: caminhoPlanoNoticias(limpo.data),
    conteudo: Buffer.from(JSON.stringify(limpo, null, 2)),
    contentType: "application/json",
  });
}

/** Onde a notícia foi amarrada, ou o motivo de ela não ter sido. */
type Amarracao = { unidadeId: string; telas: number } | { motivo: string };

/**
 * Abre a unidade do dia e amarra nela a primeira notícia.
 *
 * É o caminho antigo, com uma diferença: o registro do plano é gravado **antes**
 * do `createOrder`, ainda sem `unidadeId`. É essa reserva que faz a segunda
 * notícia aprovada no mesmo minuto esperar, em vez de abrir a segunda unidade do
 * dia travando as mesmas telas. Se a criação morrer no meio, o lease vence e a
 * volta seguinte tenta de novo — o registro sem `unidadeId` não engana ninguém.
 */
async function abrirPlano(
  estado: EstadoNoticia,
  grupoId: string,
  data: string,
  opts: { cfg: KumaConfig; log: (m: string) => void; cidade: string; frequencia: number },
): Promise<Amarracao> {
  const { cfg, log, cidade, frequencia } = opts;
  const id = estado.id;

  const telas = await resolverTelas(cidade, log);
  const disponiveis = await inventarioEmLotes(
    {
      cityId: cidade,
      targetIds: telas,
      startDate: data,
      endDate: data,
      durationInSecond: estado.duracao,
      frequency: frequencia,
    },
    cfg,
  );
  log(`${id}: inventário ${disponiveis.length} de ${telas.length} tela(s)`);
  if (!disponiveis.length) {
    return { motivo: `nenhuma tela com inventário para ${data} a ${frequencia} exibições/dia` };
  }

  const agora = new Date().toISOString();
  const reserva: PlanoNoticias = {
    data,
    duracao: estado.duracao,
    frequencia,
    grupos: [],
    criadoEm: agora,
    criandoEm: agora,
  };
  await gravarPlano(reserva);
  await gravar({ ...estado, criandoEm: agora });

  const unidadeId = await createOrder(
    {
      cityId: cidade,
      targetIds: disponiveis,
      goalLocationNum: disponiveis.length,
      startDate: data,
      endDate: data,
      durationInSecond: estado.duracao,
      frequency: frequencia,
    },
    cfg,
  );
  log(`${id}: unidade ${unidadeId} criada para ${data}`);

  // Unidade sem criativo trava inventário e não exibe nada.
  const estrategia = gruposParaEstrategia([grupoId], frequencia);
  try {
    await createOrderStrategy(unidadeId, estrategia, cfg);
  } catch (e) {
    log(`${id}: amarramento falhou — cancelando a unidade ${unidadeId}`);
    await cancelOrder(unidadeId, cfg).catch((err) =>
      console.error(`[noticia] cancelamento também falhou, cancele no portal: ${err}`),
    );
    // A reserva sai junto: sem unidade, o dia não tem plano nenhum.
    await apagar(caminhoPlanoNoticias(data)).catch(() => {});
    await gravar({ ...estado, criandoEm: undefined }).catch(() => {});
    throw e;
  }

  const detalhe = await getOrderDetail(unidadeId, cfg);
  const travadas = detalhe.orderItems[0]?.reservedLocationIds?.length ?? 0;
  await gravarPlano({
    ...reserva,
    unidadeId,
    grupos: [grupoId],
    estrategia,
    telas: travadas,
    atualizadoEm: new Date().toISOString(),
    criandoEm: undefined,
  });

  /*
   * O nome não leva mais o índice da notícia. Ele estava ali porque cada envio
   * tinha a sua unidade e só a data não distinguia uma da outra na lista do
   * portal; agora a unidade é do dia e comporta as notícias todas.
   */
  await nomearPlano(unidadeId, data, cfg, log, `${nomeDoPlano(data)} NEWS`);

  return { unidadeId, telas: travadas };
}

/**
 * A unidade que o plano do dia aponta ainda serve?
 *
 * Mesma regra do clima (`unidadeAindaVale`, em `agendar.ts`): **"não sei" conta
 * como "serve"**. Falha de rede ao consultar não é prova de que a unidade sumiu,
 * e tratar dúvida como ausência abriria um segundo plano travando as mesmas
 * telas. Só resposta definitiva derruba o registro — cancelada, encerrada, ou o
 * `-10` de pedido inexistente, que é como unidade cancelada costuma aparecer.
 *
 * A mesma chamada devolve as telas travadas agora, que é o número honesto para
 * gravar no envio: o do registro foi lido quando a unidade nasceu.
 */
async function unidadeDoPlano(
  unidadeId: string,
  cfg: KumaConfig,
): Promise<{ serve: boolean; motivo: string; telas?: number }> {
  try {
    const detalhe = await getOrderDetail(unidadeId, cfg);
    const morta = detalhe.orderStatus === "CANCELLED" || detalhe.orderStatus === "TERMINATED";
    return {
      serve: !morta,
      motivo: detalhe.orderStatus.toLowerCase(),
      telas: detalhe.orderItems[0]?.reservedLocationIds?.length,
    };
  } catch (e) {
    const erro = e instanceof KumaError ? e : null;
    const inexistente =
      erro?.code === -10 || /not found/i.test(e instanceof Error ? e.message : "");
    if (inexistente) return { serve: false, motivo: "inexistente" };
    return { serve: true, motivo: `impossível confirmar (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * Amarra a notícia no plano que o dia já tem.
 *
 * A notícia entra na lista de grupos do plano e a estratégia é remontada com
 * todos eles: a chamada substitui a estratégia inteira, então mandar só o grupo
 * novo tiraria as notícias anteriores do ar. A recém-aprovada estreia em
 * minutos, e o que muda para as que já estavam no ar é a fatia — as exibições
 * do dia passam a ser divididas por mais uma.
 *
 * Nenhuma tela é travada aqui: a unidade já reservou as dela quando nasceu, e é
 * justamente isso que o plano compartilhado economiza — antes, quatro notícias
 * eram quatro unidades pedindo 240 exibições/dia cada nas mesmas telas.
 */
async function entrarNoPlano(
  estado: EstadoNoticia,
  grupoId: string,
  plano: PlanoNoticias & { unidadeId: string },
  opts: { cfg: KumaConfig; log: (m: string) => void; frequencia: number },
): Promise<Amarracao> {
  const { cfg, log, frequencia } = opts;
  const id = estado.id;
  const slots = slotsDaFrequencia(frequencia);

  // Reentrância: a estratégia já foi trocada numa volta anterior e o que faltou
  // foi gravar o envio. Repetir a chamada não estragaria nada, mas nada mudaria.
  if (plano.grupos.includes(grupoId)) {
    log(`${id}: grupo ${grupoId} já estava no plano ${plano.unidadeId}`);
    return { unidadeId: plano.unidadeId, telas: plano.telas ?? 0 };
  }

  if (plano.duracao !== estado.duracao) {
    return {
      motivo:
        `plano de ${plano.data} veicula em ${plano.duracao}s e este envio é de ${estado.duracao}s — ` +
        "a duração é da unidade, não da notícia",
    };
  }

  if (plano.grupos.length >= slots) {
    return {
      motivo:
        `plano de ${plano.data} já está com ${plano.grupos.length} notícia(s), o máximo que ` +
        `${frequencia} exibições/dia comporta`,
    };
  }

  /*
   * A unidade do dia pode ter sido cancelada no portal entre uma notícia e a
   * próxima. Se foi, o registro do plano sai e este envio para com o motivo à
   * mostra: recriar sozinha a unidade que alguém cancelou é a automação
   * discutindo com quem opera. Sem o registro, a próxima notícia do dia abre um
   * plano novo — mas por conta de um envio novo, não por insistência.
   */
  const unidade = await unidadeDoPlano(plano.unidadeId, cfg);
  if (!unidade.serve) {
    await apagar(caminhoPlanoNoticias(plano.data)).catch(() => {});
    return {
      motivo: `plano de ${plano.data} está ${unidade.motivo} (unidade ${plano.unidadeId})`,
    };
  }
  const telas = unidade.telas ?? plano.telas ?? 0;

  const grupos = [...plano.grupos, grupoId];
  const agora = new Date().toISOString();
  await gravarPlano({ ...plano, criandoEm: agora });
  await gravar({ ...estado, criandoEm: agora });

  const estrategia = gruposParaEstrategia(grupos, frequencia);
  try {
    await createOrderStrategy(plano.unidadeId, estrategia, cfg);
  } catch (e) {
    /*
     * Aqui a unidade **não** é cancelada, ao contrário do caminho que a cria:
     * ela já tem as notícias anteriores no ar, e derrubá-la por causa de uma que
     * não entrou tiraria as outras junto. A lista fica como estava e o cron
     * tenta de novo no minuto seguinte.
     */
    await gravarPlano({ ...plano, criandoEm: undefined }).catch(() => {});
    await gravar({ ...estado, criandoEm: undefined }).catch(() => {});
    throw e;
  }

  await gravarPlano({
    ...plano,
    grupos,
    estrategia,
    telas,
    atualizadoEm: new Date().toISOString(),
    criandoEm: undefined,
  });
  log(
    `${id}: entrou no plano ${plano.unidadeId} — ${grupos.length} de até ${slots} notícia(s) ` +
      `dividindo ${frequencia} exibições/dia`,
  );

  return { unidadeId: plano.unidadeId, telas };
}

export type PassoEstrategia =
  | { estado: "reescrita"; data: string; unidadeId: string; noticias: number; vagas: number }
  | { estado: "em-dia"; data: string; noticias: number }
  | { estado: "sem-estrategia"; data: string; motivo: string };

/**
 * Confere se a estratégia da unidade do dia carrega as notícias todas.
 *
 * Na maioria das voltas ela não faz nada: o registro do plano guarda a lista que
 * foi mandada no último `createOrderStrategy`, e quando ela bate com a que o
 * plano pede o custo da volta é a leitura de um JSON. Existe para as situações
 * em que a estratégia fica para trás do plano sem ninguém perceber, porque o
 * Kuma não tem endpoint para ler a estratégia de uma unidade:
 *
 *  - uma volta que morreu entre gravar a lista e mandá-la ao Kuma; e
 *  - os planos criados enquanto o rodízio existiu (01 a 03/09/2026), que têm um
 *    grupo só na estratégia e as outras notícias do dia fora do ar. A primeira
 *    volta reescreve a estratégia com todas e o plano entra no regime certo, sem
 *    ninguém precisar reenviar notícia nenhuma.
 */
export async function sincronizarEstrategia(
  dataISO: string,
  opts: { cfg?: KumaConfig; log?: (m: string) => void } = {},
): Promise<PassoEstrategia> {
  const log = opts.log ?? (() => {});
  const plano = await lerJson<PlanoNoticias>(caminhoPlanoNoticias(dataISO));

  if (!plano) return { estado: "sem-estrategia", data: dataISO, motivo: "o dia não tem plano" };
  if (!plano.unidadeId) {
    return { estado: "sem-estrategia", data: dataISO, motivo: "plano sem unidade ainda" };
  }
  if (plano.criandoEm && Date.now() - Date.parse(plano.criandoEm) < LEASE_SEGUNDOS * 1_000) {
    // Uma notícia está entrando no plano neste instante, e ela também escreve a
    // estratégia. Duas escritas no mesmo minuto deixariam o registro descrevendo
    // uma lista e a unidade tocando outra.
    return { estado: "sem-estrategia", data: dataISO, motivo: "plano em atualização" };
  }
  if (!plano.grupos.length) {
    return { estado: "sem-estrategia", data: dataISO, motivo: "plano sem grupo criativo" };
  }

  const estrategia = gruposParaEstrategia(plano.grupos, plano.frequencia);
  if (mesmaEstrategia(plano.estrategia, estrategia)) {
    return { estado: "em-dia", data: dataISO, noticias: plano.grupos.length };
  }

  const conta = process.env.KUMA_BIDDER_NEWS?.trim();
  if (!conta) {
    throw new Error(
      "KUMA_BIDDER_NEWS não configurada — sem ela a estratégia iria para a conta do clima.",
    );
  }
  const cfg = opts.cfg ?? kumaConfig(conta);

  const agora = new Date().toISOString();
  await gravarPlano({ ...plano, criandoEm: agora });
  try {
    await createOrderStrategy(plano.unidadeId, estrategia, cfg);
  } catch (e) {
    // O registro volta a descrever o que está no ar de verdade: a escrita não
    // aconteceu, então `estrategia` continua sendo a lista anterior. A volta
    // seguinte do cron tenta de novo.
    await gravarPlano({ ...plano, criandoEm: undefined }).catch(() => {});
    throw e;
  }
  await gravarPlano({
    ...plano,
    estrategia,
    atualizadoEm: new Date().toISOString(),
    criandoEm: undefined,
  });

  log(
    `plano de ${dataISO}: estratégia reescrita com ${plano.grupos.length} notícia(s) ` +
      `em ${estrategia.length} vaga(s)`,
  );
  return {
    estado: "reescrita",
    data: dataISO,
    unidadeId: plano.unidadeId,
    noticias: plano.grupos.length,
    vagas: estrategia.length,
  };
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

  /* ── 4. Entrar no plano do dia ────────────────────────────── */
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
   *
   * É também a data que escolhe o plano: quem atravessa a meia-noite entra no
   * plano do dia novo, junto com as notícias de hoje, e não no de ontem.
   */
  const dataVeiculacao =
    estado.data < dataEmSaoPaulo(0) ? dataEmSaoPaulo(0) : estado.data;
  if (dataVeiculacao !== estado.data) {
    log(`${id}: envio é de ${estado.data} e já virou o dia — veicula em ${dataVeiculacao}`);
  }

  const plano = await lerJson<PlanoNoticias>(caminhoPlanoNoticias(dataVeiculacao));

  /*
   * Outra notícia está criando a unidade do dia ou trocando a estratégia dela
   * neste instante. Esperar o próximo minuto é o certo: duas notícias que leiam
   * a mesma lista de grupos mandariam duas estratégias, e como a chamada
   * substitui tudo, a última apagaria a primeira do ar.
   */
  if (plano?.criandoEm && Date.now() - Date.parse(plano.criandoEm) < LEASE_SEGUNDOS * 1_000) {
    return {
      estado: "aguardando-aprovacao",
      id,
      grupoId: estado.grupoId,
      auditoria: `plano de ${dataVeiculacao} em atualização`,
    };
  }

  const amarracao =
    plano && plano.unidadeId
      ? await entrarNoPlano(estado, estado.grupoId, { ...plano, unidadeId: plano.unidadeId }, {
          cfg,
          log,
          frequencia,
        })
      : await abrirPlano(estado, estado.grupoId, dataVeiculacao, {
          cfg,
          log,
          cidade,
          frequencia,
        });

  if ("motivo" in amarracao) {
    await gravar({ ...estado, erro: amarracao.motivo, criandoEm: undefined });
    log(`${id}: ${amarracao.motivo} — envio parado`);
    return { estado: "parado", id, motivo: amarracao.motivo };
  }

  await gravar({
    ...estado,
    unidadeId: amarracao.unidadeId,
    agendadoEm: new Date().toISOString(),
    telas: amarracao.telas,
    criandoEm: undefined,
  });
  log(`${id}: no ar em ${amarracao.telas} tela(s), plano ${amarracao.unidadeId}`);

  return {
    estado: "no-ar",
    id,
    unidadeId: amarracao.unidadeId,
    telas: amarracao.telas,
  };
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
