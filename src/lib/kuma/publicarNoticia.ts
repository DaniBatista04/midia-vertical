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
 * do mesmo dia são amarrados nela. Os grupos se dividem em caixas de até quatro,
 * e a estratégia carrega a caixa da hora: o Kuma reparte as exibições entre as
 * notícias dela, uma por exibição, e o cron troca a caixa quando a janela vira.
 * Ver `noticiaPlano.ts` para a evidência da repartição e a regra do padding que
 * a Brato exige, e `noticiaCaixas.ts` para a divisão do dia.
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
  telasTravadas,
  type KumaConfig,
  type PedidoItem,
} from "./client";
import { cidadesConfiguradas, siglaCidade } from "./cidades";
import {
  dataEmSaoPaulo,
  inventarioEmLotes,
  nomeDoPlano,
  nomearPlano,
  resolverTelas,
} from "./agendar";
import { montarGrupoNoticia } from "./newsGroup";
import {
  caminhoPlanoNoticias,
  frequenciaDaNoticia,
  mesmaEstrategia,
  type PlanoNoticias,
} from "./noticiaPlano";
import {
  caminhoGrade,
  estrategiaDaHora,
  gruposPorCaixa,
  horaEmSaoPaulo,
  vagasDaCaixa,
  type EstrategiaDaHora,
  type GradeNoticias,
} from "./noticiaCaixas";
import { caminhoNoticia, idNoticia, type EstadoNoticia } from "./noticiaEstado";
import { LEASE_SEGUNDOS } from "./estado";
import { abrirTeste } from "./testeIgnoreLock";
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

/**
 * A estratégia que o plano pede agora: a da caixa da hora, com a grade de
 * horários gravada para o dia (ou a divisão padrão, sem ela).
 */
async function estrategiaAgora(
  plano: Pick<PlanoNoticias, "data" | "grupos" | "caixaDoGrupo" | "frequencia">,
): Promise<EstrategiaDaHora> {
  const grade = await lerJson<GradeNoticias>(caminhoGrade(plano.data));
  // Plano de um dia que ainda não chegou começa pelo que toca à meia-noite dele
  // (a madrugada, que é da última caixa); a hora de hoje não diz nada sobre ele.
  const hora = plano.data > dataEmSaoPaulo(0) ? 0 : horaEmSaoPaulo();
  return estrategiaDaHora(plano, grade, hora);
}

/**
 * Onde a notícia foi amarrada, ou o motivo de ela não ter sido. `retirada` é a
 * operação ter tirado a notícia no meio da volta: o envio já está marcado, e
 * gravar o `erro` por cima com o registro lido antes apagaria a marca.
 */
type Amarracao = { unidadeId: string; telas: number } | { motivo: string; retirada?: true };

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
  opts: { cfg: KumaConfig; log: (m: string) => void; cidades: string[]; frequencia: number },
): Promise<Amarracao> {
  const { cfg, log, cidades, frequencia } = opts;
  const id = estado.id;

  /*
   * Todas as praças no mesmo pedido.
   *
   * A notícia é conteúdo nacional — o mesmo texto vai a São Paulo e ao Rio —, e
   * o Kuma amarra o criativo no plano (ver `createOrder`). Então um pedido com
   * um `orderItem` por cidade resolve as duas com um grupo criativo só, uma
   * aprovação só e um plano só na lista do portal. Dois pedidos separados
   * dobrariam tudo isso sem entregar nada diferente nas telas.
   */
  const itens: PedidoItem[] = [];
  for (const cidade of cidades) {
    const sigla = siglaCidade(cidade);
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
    log(`${id}: ${sigla} inventário ${disponiveis.length} de ${telas.length} tela(s)`);
    /*
     * Praça sem inventário sai do pedido em vez de derrubá-lo. O Rio é praça
     * nova, com telas sendo instaladas: um dia em que ele não tiver inventário
     * não pode ser um dia sem notícia em São Paulo. Fica registrado no log, e
     * o pedido segue com quem tem.
     */
    if (!disponiveis.length) {
      log(`${id}: ${sigla} ficou de fora — nenhuma tela com inventário`);
      continue;
    }
    itens.push({ cityId: cidade, targetIds: disponiveis, goalLocationNum: disponiveis.length });
  }

  if (!itens.length) {
    return { motivo: `nenhuma tela com inventário para ${data} a ${frequencia} exibições/dia` };
  }

  const agora = new Date().toISOString();
  const caixaDoGrupo = { [grupoId]: estado.caixa ?? 1 };
  const reserva: PlanoNoticias = {
    data,
    duracao: estado.duracao,
    frequencia,
    grupos: [],
    caixaDoGrupo: {},
    criadoEm: agora,
    criandoEm: agora,
  };
  await gravarPlano(reserva);
  await gravar({ ...estado, criandoEm: agora });

  const unidadeId = await createOrder(
    {
      itens,
      startDate: data,
      endDate: data,
      durationInSecond: estado.duracao,
      frequency: frequencia,
    },
    cfg,
  );
  log(
    `${id}: plano ${unidadeId} criado para ${data} em ${itens.map((i) => siglaCidade(i.cityId)).join(" + ")}`,
  );

  // Unidade sem criativo trava inventário e não exibe nada. Com um grupo só, a
  // estratégia é ele, seja qual for a caixa dele: caixa da hora vazia cai na
  // que tiver notícia.
  const { estrategia } = await estrategiaAgora({ data, grupos: [grupoId], caixaDoGrupo, frequencia });
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
  const travadas = telasTravadas(detalhe);
  await gravarPlano({
    ...reserva,
    unidadeId,
    grupos: [grupoId],
    caixaDoGrupo,
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
      telas: telasTravadas(detalhe),
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
 * A notícia entra na lista de grupos do plano, na caixa dela, e a estratégia é
 * remontada com a caixa da hora inteira: a chamada substitui a estratégia, então
 * mandar só o grupo novo tiraria as vizinhas de caixa do ar. Se a caixa dela é a
 * que está no ar, ela estreia em minutos e as vizinhas passam a dividir as
 * exibições com mais uma; se é de outra janela, só o registro muda, e ela entra
 * no ar quando o cron virar a caixa.
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
  const caixa = estado.caixa ?? 1;
  const vagas = vagasDaCaixa(await lerJson<GradeNoticias>(caminhoGrade(plano.data)), caixa, frequencia);

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

  const naCaixa = gruposPorCaixa(plano.grupos, plano.caixaDoGrupo).get(caixa)?.length ?? 0;
  if (naCaixa >= vagas) {
    return {
      motivo:
        `o pack ${caixa} de ${plano.data} já está com ${naCaixa} notícia(s), o máximo que ` +
        `${frequencia} exibições/dia comporta numa estratégia`,
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
  const caixaDoGrupo = { ...plano.caixaDoGrupo, [grupoId]: caixa };
  const agora = new Date().toISOString();
  await gravarPlano({ ...plano, criandoEm: agora });

  // A operação pode ter tirado a notícia do pack depois que esta volta leu o
  // envio. Conferido já com a trava do plano de pé, que faz a retirada esperar.
  if ((await lerNoticia(id))?.retiradaEm) {
    await gravarPlano({ ...plano, criandoEm: undefined });
    return { motivo: "retirada do pack pelo painel", retirada: true };
  }
  await gravar({ ...estado, criandoEm: agora });

  const { estrategia, caixa: noAr } = await estrategiaAgora({ ...plano, grupos, caixaDoGrupo });
  try {
    // Notícia de uma caixa que não é a da hora não muda o que está no ar.
    if (!mesmaEstrategia(plano.estrategia, estrategia)) {
      await createOrderStrategy(plano.unidadeId, estrategia, cfg);
    }
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
    caixaDoGrupo,
    estrategia,
    telas,
    atualizadoEm: new Date().toISOString(),
    criandoEm: undefined,
  });
  log(
    `${id}: entrou no plano ${plano.unidadeId} no pack ${caixa} (${naCaixa + 1} de até ${vagas}) — ` +
      (noAr === caixa ? "no ar agora" : `no ar está o pack ${noAr}`),
  );

  return { unidadeId: plano.unidadeId, telas };
}

export type PassoEstrategia =
  | {
      estado: "reescrita";
      data: string;
      unidadeId: string;
      noticias: number;
      vagas: number;
      caixa: number;
      caixas: number;
    }
  | { estado: "em-dia"; data: string; noticias: number; caixa: number; caixas: number }
  | { estado: "sem-estrategia"; data: string; motivo: string };

/**
 * Confere se a estratégia da unidade do dia carrega a caixa da hora.
 *
 * É aqui que a caixa vira: quando a janela muda, a lista que o plano pede deixa
 * de bater com a que foi mandada, e a volta reescreve a estratégia. A troca
 * chega às telas na virada seguinte da faixa de programação do Kuma, e não no
 * minuto da chamada (ver `noticiaCaixas.ts`).
 *
 * Na maioria das voltas ela não faz nada: o registro do plano guarda a lista que
 * foi mandada no último `createOrderStrategy`, e quando ela bate com a que o
 * plano pede o custo da volta é a leitura de dois JSON. Além da virada da caixa,
 * existe para as situações em que a estratégia fica para trás do plano sem
 * ninguém perceber, porque o Kuma não tem endpoint para ler a estratégia de uma
 * unidade:
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

  const { estrategia, caixa, caixas } = await estrategiaAgora(plano);
  const naCaixa = estrategia.filter((g, i) => estrategia.indexOf(g) === i).length;
  if (mesmaEstrategia(plano.estrategia, estrategia)) {
    return { estado: "em-dia", data: dataISO, noticias: naCaixa, caixa, caixas };
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
    `plano de ${dataISO}: estratégia reescrita com o pack ${caixa} de ${caixas} — ` +
      `${naCaixa} notícia(s) em ${estrategia.length} vaga(s)`,
  );
  return {
    estado: "reescrita",
    data: dataISO,
    unidadeId: plano.unidadeId,
    noticias: naCaixa,
    vagas: estrategia.length,
    caixa,
    caixas,
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
  if (estado.retiradaEm) return { estado: "parado", id, motivo: "retirada do pack pelo painel" };

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
  const cidades = cidadesConfiguradas(process.env.KUMA_CLIMA_CIDADE);
  const frequencia = frequenciaDaNoticia();

  const emCurso = estado.criandoEm ? Date.parse(estado.criandoEm) : 0;
  if (emCurso && Date.now() - emCurso < LEASE_SEGUNDOS * 1_000) {
    return { estado: "aguardando-aprovacao", id, grupoId: estado.grupoId, auditoria: "criação em andamento" };
  }

  // Envio de teste do `ignoreLock`: plano e unidade só dele, longe do plano do
  // dia (ver `testeIgnoreLock.ts`).
  if (estado.teste) {
    const comTrava = { ...estado, criandoEm: new Date().toISOString() };
    await gravar(comTrava);
    const r = await abrirTeste({ ...comTrava, teste: estado.teste, grupoId: estado.grupoId }, { cfg, log });
    if (!r.ok) return { estado: "parado", id, motivo: r.motivo };
    return { estado: "no-ar", id, unidadeId: r.planoId, telas: r.telas };
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
          cidades,
          frequencia,
        });

  if ("motivo" in amarracao) {
    if (amarracao.retirada) return { estado: "parado", id, motivo: amarracao.motivo };
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

export type Retirada =
  | { estado: "retirada"; id: string; caixaNoAr: number | null }
  | { estado: "recusada"; id: string; motivo: string; status: 404 | 409 };

/**
 * Tira uma notícia do pack: o grupo sai do plano, e a estratégia é reescrita se
 * ele estava no ar. É o que a operação usa para abrir vaga para uma notícia
 * urgente num pack cheio.
 *
 * O envio é marcado (`retiradaEm`) **antes** de o plano ser lido, e é essa marca
 * que tira o envio da varredura do cron: uma notícia ainda em aprovação não entra
 * mais quando for aprovada. Se o cron já tinha lido o envio antes da marca, ele
 * confere de novo em `entrarNoPlano`, depois de pegar a trava do plano — e a
 * trava de pé faz esta função recusar e desfazer a marca. A unidade não muda — nenhuma tela é liberada nem
 * travada, só a lista da estratégia.
 *
 * Duas recusas:
 *  - a notícia está entrando no plano neste minuto (a marca do envio ou do
 *    plano está de pé), e mexer agora deixaria o registro e a unidade
 *    descrevendo listas diferentes; o painel pede para tentar de novo; e
 *  - é a última notícia do plano do dia. Unidade sem criativo trava as telas e
 *    não exibe nada, e cancelar a unidade é decisão do portal, não de um botão.
 */
export async function retirarNoticia(
  id: string,
  opts: { cfg?: KumaConfig; log?: (m: string) => void } = {},
): Promise<Retirada> {
  const log = opts.log ?? (() => {});
  const estado = await lerNoticia(id);
  if (!estado) return { estado: "recusada", id, motivo: `envio ${id} não existe`, status: 404 };
  if (estado.retiradaEm) return { estado: "retirada", id, caixaNoAr: null };

  const vivo = (marca?: string) =>
    Boolean(marca) && Date.now() - Date.parse(marca!) < LEASE_SEGUNDOS * 1_000;
  const espere = { estado: "recusada", id, status: 409 } as const;
  if (vivo(estado.criandoEm)) {
    return { ...espere, motivo: "a notícia está entrando no plano agora — tente de novo em um minuto" };
  }

  await gravar({ ...estado, retiradaEm: new Date().toISOString() });
  const desfazer = async (motivo: string): Promise<Retirada> => {
    await gravar({ ...estado, retiradaEm: undefined });
    return { ...espere, motivo };
  };

  // O plano pode ser o da data do envio ou o de hoje: aprovação que atravessa a
  // meia-noite entra no plano do dia novo (ver `avancarNoticia`).
  const datas = [...new Set([estado.data, dataEmSaoPaulo(0)])];
  let plano: PlanoNoticias | null = null;
  for (const d of datas) {
    const p = await lerJson<PlanoNoticias>(caminhoPlanoNoticias(d));
    if (vivo(p?.criandoEm)) {
      return desfazer("o plano do dia está sendo atualizado — tente de novo em um minuto");
    }
    if (estado.grupoId && p?.grupos.includes(estado.grupoId)) plano = p;
  }

  const grupos = plano ? plano.grupos.filter((g) => g !== estado.grupoId) : [];
  if (plano && !grupos.length) {
    return desfazer(
      "é a única notícia no plano do dia, e unidade sem criativo trava as telas — " +
        "envie outra notícia e tire esta depois que a nova for aprovada",
    );
  }

  if (!plano) {
    log(`${id}: retirada antes de entrar no plano`);
    return { estado: "retirada", id, caixaNoAr: null };
  }

  const caixaDoGrupo = { ...plano.caixaDoGrupo };
  delete caixaDoGrupo[estado.grupoId!];
  const novo = { ...plano, grupos, caixaDoGrupo };
  const { estrategia, caixa } = await estrategiaAgora(novo);

  // Plano de outro dia não exibe mais nada: só o registro muda.
  const noAr = plano.data === dataEmSaoPaulo(0) && plano.unidadeId;
  if (noAr && !mesmaEstrategia(plano.estrategia, estrategia)) {
    const conta = process.env.KUMA_BIDDER_NEWS?.trim();
    if (!conta) {
      throw new Error("KUMA_BIDDER_NEWS não configurada — sem ela a estratégia iria para a conta do clima.");
    }
    await gravarPlano({ ...plano, criandoEm: new Date().toISOString() });
    try {
      await createOrderStrategy(plano.unidadeId!, estrategia, opts.cfg ?? kumaConfig(conta));
    } catch (e) {
      // A notícia continua no plano e no ar; a marca sai para ela poder ser
      // retirada de novo.
      await gravarPlano({ ...plano, criandoEm: undefined }).catch(() => {});
      await gravar({ ...estado, retiradaEm: undefined }).catch(() => {});
      throw e;
    }
    await gravarPlano({ ...novo, estrategia, atualizadoEm: new Date().toISOString(), criandoEm: undefined });
    log(`${id}: retirada do plano ${plano.unidadeId} — no ar fica o pack ${caixa}`);
  } else {
    await gravarPlano({ ...novo, atualizadoEm: new Date().toISOString() });
    log(`${id}: retirada do plano ${plano.unidadeId ?? plano.data} — a estratégia no ar não muda`);
  }
  return { estado: "retirada", id, caixaNoAr: noAr ? caixa : null };
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

/**
 * O que o dia já tem: os envios registrados e o próximo índice livre.
 *
 * O índice separa as notícias de um mesmo dia e entra no nome do arquivo — e
 * nome repetido entre requisições é reprovado pelo Kuma com 502 e feedback
 * vazio. Procurar o primeiro id livre é o que garante que dois envios no mesmo
 * dia não colidam.
 *
 * A varredura para no primeiro id ausente, e os envios devolvidos são os que
 * vêm antes dele — que é exatamente o que a busca pelo índice livre já
 * enxergava. Ler o bucket inteiro para contar as notícias de um dia não se paga.
 */
export async function enviosDoDia(
  dataISO: string,
): Promise<{ envios: EstadoNoticia[]; indice: number }> {
  const envios: EstadoNoticia[] = [];
  for (let i = 1; i <= 50; i++) {
    const existe = await lerJson<EstadoNoticia>(caminhoNoticia(idNoticia(dataISO, i)));
    if (!existe) return { envios, indice: i };
    envios.push(existe);
  }
  throw new Error(`já existem 50 envios para ${dataISO} — algo está errado`);
}
