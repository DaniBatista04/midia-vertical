/**
 * Fase 2 do clima: cria a unidade do dia e amarra o grupo criativo.
 *
 * Ela é separada da fase das 23h por uma imposição da API: a estratégia só
 * aceita grupo **aprovado** — com auditoria pendente a resposta é `-12`. Como a
 * aprovação é manual no portal, esta fase roda em intervalos curtos e só age
 * quando encontra o grupo do dia já aprovado.
 *
 * A lógica mora aqui, e não no script, porque três chamadores precisam dela:
 * o cron da Vercel, o link que a pessoa clica logo depois de aprovar, e o CLI
 * de `npm run clima:agendar`. Uma cópia por chamador divergiria na primeira
 * mudança de regra.
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
  KumaError,
  renomearPlano,
  type KumaConfig,
} from "./client";
import { caminhoEstado, LEASE_SEGUNDOS, type EstadoDoDia } from "./estado";
import { lerJson, uploadPublico } from "../server/supabaseUpload";

/** São Paulo. */
export const CIDADE_PADRAO = "6003";

/**
 * Exibições por dia por tela. Múltiplo de 300, e 600 não é chute: medido em
 * amostra de 116 telas, 600/dia cabe em 100% delas, 1800 em 95% e 3600 em 23%.
 */
export const FREQUENCIA_PADRAO = 600;

/**
 * A data de veiculação é sempre em horário de Brasília, calculada de forma
 * explícita em vez de depender do fuso do host.
 *
 * Isso já quebrou uma vez: o runner do GitHub é UTC, e `new Date()` depois da
 * meia-noite UTC já está no dia seguinte — a fase procurava o registro do dia
 * errado. Lá a correção foi `TZ: America/Sao_Paulo` no workflow, mas o runtime
 * da Vercel também é UTC e não tem workflow onde fixar isso. Calcular pelo
 * `Intl` deixa a função correta em qualquer host, sem variável de ambiente.
 */
export function dataEmSaoPaulo(deslocamentoEmDias = 0): string {
  const agora = new Date();
  if (deslocamentoEmDias) agora.setUTCDate(agora.getUTCDate() + deslocamentoEmDias);
  // `en-CA` formata como YYYY-MM-DD, que é exatamente o formato da API.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/**
 * Nome do plano na lista do portal: a data em que aquilo vai ao ar, `MM/DD`.
 *
 * A ordem é mês/dia, não dia/mês — é como a equipe nomeia hoje (o exemplo que
 * me deram para 19 de agosto foi `08/19`) e como o portal apresenta data. Muda
 * aqui se a convenção mudar; é o único lugar que decide isso.
 */
export function nomeDoPlano(dataISO: string): string {
  const [, mes, dia] = dataISO.split("-");
  return `${mes}/${dia}`;
}

export type ResultadoAgendamento =
  | {
      estado: "agendado";
      data: string;
      grupoId: string;
      unidadeId: string;
      telas: number;
      situacao: string;
    }
  | { estado: "ja-agendado"; data: string; unidadeId: string }
  | { estado: "pendente"; data: string; grupoId: string; auditoria: string }
  | { estado: "simulado"; data: string; grupoId: string; telasDisponiveis: number }
  | { estado: "sem-registro"; datas: string[] };

export type OpcoesAgendamento = {
  /** Data específica. Sem ela, tenta hoje e depois amanhã. */
  data?: string;
  /** Faz tudo menos criar a unidade e amarrar o criativo. */
  simular?: boolean;
  cidade?: string;
  frequencia?: number;
  /** Janela de veiculação em horas cheias. Ver `horasDaJanela`. */
  horas?: number[];
  /**
   * Agenda este grupo criativo em vez do que o registro do dia aponta.
   *
   * Existe para ensaio: permite pôr no ar, numa data e janela escolhidas, um
   * criativo que já passou pela auditoria, sem depender de haver registro
   * daquele dia. Continua valendo tudo o que protege o resto — o grupo precisa
   * ser da conta Weather e estar **aprovado**, senão a chamada é recusada.
   *
   * Não é caminho de produção: o dia a dia é o registro que a fase 1 deixa.
   */
  grupo?: string;
  log?: (mensagem: string) => void;
  cfg?: KumaConfig;
};

/**
 * Janela de veiculação, em horas cheias.
 *
 * As telas tocam comunicado em janelas de duas horas — 10h–12h, 12h–14h, até
 * 16h–18h — e a API recebe isso como a lista de horas incluídas: a janela das
 * 16h é `[16, 17]`. Aceita `"16,17"` e também `"16-18"`, que é como a janela é
 * falada no dia a dia e cujo fim é exclusivo.
 *
 * Sem configuração, devolve `undefined` e o campo nem vai no pedido — o Kuma
 * decide, que é como o clima funcionou até aqui.
 */
export function horasDaJanela(valor: string | undefined): number[] | undefined {
  const cru = (valor ?? "").trim();
  if (!cru) return undefined;

  const intervalo = cru.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  const horas = intervalo
    ? Array.from(
        { length: Number(intervalo[2]) - Number(intervalo[1]) },
        (_, i) => Number(intervalo[1]) + i,
      )
    : cru.split(",").map((h) => Number(h.trim()));

  if (!horas.length || horas.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw new Error(`janela de veiculação inválida: "${cru}" — use "16,17" ou "16-18"`);
  }
  return horas;
}

/** Erro de agendamento que já vem com texto pronto para quem opera. */
export class AgendamentoError extends Error {
  readonly data: string;
  constructor(mensagem: string, data: string) {
    super(mensagem);
    this.name = "AgendamentoError";
    this.data = data;
  }
}

/**
 * Datas candidatas, em ordem de urgência.
 *
 * A fase 1 roda às 23h e submete o clima do dia seguinte. Esta fase roda da
 * meia-noite ao meio-dia, quando aquele "dia seguinte" já virou **hoje** — daí
 * hoje vir primeiro. Amanhã entra depois para cobrir o envio manual adiantado.
 */
function datasCandidatas(data?: string): string[] {
  if (data) return [data];
  return [dataEmSaoPaulo(0), dataEmSaoPaulo(1)];
}

/**
 * Resolve as telas alvo. Exige configuração explícita: uma unidade consome
 * inventário de tela física, então "todas as telas da cidade" nunca é padrão.
 */
async function resolverTelas(cidade: string, log: (m: string) => void): Promise<string[]> {
  const lista = (v: string | undefined) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const telas = lista(process.env.KUMA_CLIMA_TELAS);
  if (telas.length) return telas;

  const predios = lista(process.env.KUMA_CLIMA_PREDIOS);
  if (!predios.length) {
    throw new Error("defina KUMA_CLIMA_TELAS ou KUMA_CLIMA_PREDIOS — o alvo do pedido não tem padrão");
  }
  const locais = await getValidLocations(cidade, predios);
  log(`${predios.length} prédio(s) → ${locais.length} tela(s)`);
  return locais.map((l) => l.locationId);
}

/** Grava o registro do dia. Campo `undefined` some do JSON, que é o desejado. */
async function gravarEstado(caminho: string, estado: EstadoDoDia): Promise<void> {
  await uploadPublico({
    caminho,
    conteudo: Buffer.from(JSON.stringify(estado, null, 2)),
    contentType: "application/json",
  });
}

/**
 * A unidade que o registro do dia aponta ainda vale?
 *
 * "Não sei" precisa contar como "vale". Falha de rede ao consultar não é prova
 * de que a unidade sumiu, e tratar dúvida como ausência criaria uma segunda
 * unidade travando as mesmas telas — exatamente o defeito que já nasceu duas
 * vezes aqui. Só resposta definitiva da API derruba o registro: a unidade lida
 * como cancelada/encerrada, ou o `-10` de pedido inexistente.
 *
 * O caminho do "inexistente" importa na prática: unidade cancelada some do
 * `getOrderDetail` em vez de voltar com `CANCELLED`, e sem isto um registro
 * apontando para unidade morta faria a automação sair em silêncio num dia em
 * que o clima não vai ao ar.
 */
async function unidadeAindaVale(
  unidadeId: string,
  cfg: KumaConfig,
): Promise<{ vale: boolean; motivo: string }> {
  try {
    const detalhe = await getOrderDetail(unidadeId, cfg);
    // Só `CANCELLED` libera recriar. `TERMINATED` e `FINISH` são unidade que
    // já cumpriu (ou encerrou) o papel dela — recriar em cima disso é inventar
    // veiculação que ninguém pediu, ainda mais num dia passado.
    // "No ar ou a caminho" é o que conta. `FINISH` fica de fora porque unidade
    // que cumpriu o dia dela não precisa de substituta.
    const morta =
      detalhe.orderStatus === "CANCELLED" || detalhe.orderStatus === "TERMINATED";
    return { vale: !morta, motivo: detalhe.orderStatus.toLowerCase() };
  } catch (e) {
    const erro = e instanceof KumaError ? e : null;
    const inexistente = erro?.code === -10 || /not found/i.test(e instanceof Error ? e.message : "");
    if (inexistente) return { vale: false, motivo: "inexistente" };
    return {
      vale: true,
      motivo: `impossível confirmar (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/** Devolve null quando não há registro para esta data. */
async function processar(
  data: string,
  opts: Required<Pick<OpcoesAgendamento, "cidade" | "frequencia" | "simular">> & {
    cfg: KumaConfig;
    log: (m: string) => void;
    horas?: number[];
    grupo?: string;
  },
): Promise<ResultadoAgendamento | null> {
  const { cfg, log, cidade, frequencia, simular, horas, grupo: grupoEnsaio } = opts;
  const caminho = caminhoEstado(data);
  const registro = await lerJson<EstadoDoDia>(caminho);

  // Num ensaio com `grupo` explícito pode não existir registro daquele dia, e
  // se existir ele não deve ser sobrescrito. Monta-se um registro de trabalho
  // só para o resto do fluxo ter o que ler; `ensaio` corta a gravação no fim.
  const ensaio = Boolean(grupoEnsaio) && registro?.grupoId !== grupoEnsaio;
  const estado: EstadoDoDia | null = grupoEnsaio
    ? {
        ...(registro ?? {
          data,
          nomeGrupo: "",
          indice: 0,
          duracao: 10,
          submetidoEm: "",
          materiais: [],
        }),
        grupoId: grupoEnsaio,
        unidadeId: undefined,
      }
    : registro;
  if (!estado) return null;
  if (ensaio) {
    log(`${data}: ENSAIO com o grupo ${grupoEnsaio} — o registro do dia não será alterado`);
  }

  /**
   * A unidade que este ciclo já concluiu estar fora do ar.
   *
   * Guardada porque a checagem logo antes de criar precisa distinguir "outra
   * execução agendou enquanto eu trabalhava" de "o registro continua com a
   * mesma unidade morta que eu vim substituir". Sem isso, a própria trava
   * contra corrida impede a recriação e o ciclo vira um laço quente: consulta
   * tudo de novo a cada minuto e nunca conclui nada.
   */
  let unidadeMorta: string | undefined;

  if (estado.unidadeId) {
    const anterior = await unidadeAindaVale(estado.unidadeId, cfg);
    if (anterior.vale) {
      log(`${data}: já agendado na unidade ${estado.unidadeId} (${anterior.motivo})`);
      return { estado: "ja-agendado", data, unidadeId: estado.unidadeId };
    }

    /*
     * A unidade do registro não está no ar. Duas histórias diferentes levam
     * aqui, e elas pedem respostas opostas:
     *
     *  - registro velho apontando para unidade de teste já cancelada — o certo
     *    é agendar de novo, senão o clima não vai ao ar e ninguém é avisado;
     *  - alguém cancelou a unidade no portal de propósito — o certo é **não**
     *    recriar, senão a automação briga com a pessoa uma vez por minuto.
     *
     * Como daqui não dá para saber qual das duas é, recria **uma vez** e para.
     * Se a segunda unidade também morrer, foi decisão de gente, e o resultado
     * fica visível como erro em vez de virar um moinho.
     */
    const recriacoes = estado.recriacoes ?? 0;
    if (recriacoes >= 1) {
      throw new AgendamentoError(
        `a unidade ${estado.unidadeId} de ${data} está ${anterior.motivo} e já foi recriada uma vez — ` +
          "se o cancelamento foi intencional, nada a fazer; se não, agende pelo portal",
        data,
      );
    }
    log(`${data}: a unidade ${estado.unidadeId} está ${anterior.motivo} — recriando (tentativa única)`);
    unidadeMorta = estado.unidadeId;
    estado.recriacoes = recriacoes + 1;
  }

  const janela = horas?.length ? ` · janela ${horas[0]}h–${horas[horas.length - 1] + 1}h` : "";
  log(`${data}: grupo ${estado.grupoId} · cidade ${cidade} · ${frequencia} exibições/dia${janela}`);

  const grupo = await getCreativeGroup(estado.grupoId, cfg);
  const auditoria = descreverAuditoria(grupo.audit.status);
  log(`auditoria: ${auditoria}`);

  if (grupo.audit.status === 1) {
    return { estado: "pendente", data, grupoId: estado.grupoId, auditoria };
  }
  if (grupo.audit.status !== 3) {
    throw new AgendamentoError(
      `criativo de ${data} não está aprovado (${auditoria}) — regenere o clima com --indice maior`,
      data,
    );
  }

  const telas = await resolverTelas(cidade, log);
  const disponiveis = await inquireSufficientTargets(
    {
      cityId: cidade,
      targetIds: telas,
      startDate: data,
      endDate: data,
      durationInSecond: estado.duracao,
      frequency: frequencia,
      // `hours` NÃO vai aqui de propósito, apesar de existir no contrato: o
      // `inquireSufficientTargets` estoura com HTTP 400 e
      // `UnsupportedOperationException` ao desserializar o campo — bug do lado
      // deles, com cara de coleção imutável que o Jackson tenta preencher.
      // Medido em 18/08/2026. A consulta então é do dia inteiro, que é a
      // pergunta mais larga; a janela vale na criação da unidade.
    },
    cfg,
  );
  log(`inventário: ${disponiveis.length} de ${telas.length} tela(s) disponíveis`);
  if (!disponiveis.length) {
    throw new AgendamentoError(
      `nenhuma tela com inventário para ${data} a ${frequencia} exibições/dia`,
      data,
    );
  }

  if (simular) {
    return { estado: "simulado", data, grupoId: estado.grupoId, telasDisponiveis: disponiveis.length };
  }

  if (!ensaio) {
    // Última leitura antes de criar, agora que inventário e auditoria já
    // custaram alguns segundos: outra chamada pode ter agendado nesse meio.
    const agora = await lerJson<EstadoDoDia>(caminho);
    if (agora?.unidadeId && agora.unidadeId !== unidadeMorta) {
      log(`${data}: outra execução agendou na unidade ${agora.unidadeId} — nada a fazer`);
      return { estado: "ja-agendado", data, unidadeId: agora.unidadeId };
    }
    const emCurso = agora?.criandoEm ? Date.parse(agora.criandoEm) : 0;
    if (emCurso && Date.now() - emCurso < LEASE_SEGUNDOS * 1_000) {
      log(`${data}: outra execução está criando a unidade desde ${agora!.criandoEm} — saindo`);
      return { estado: "pendente", data, grupoId: estado.grupoId, auditoria: "criação em andamento" };
    }
    await gravarEstado(caminho, { ...estado, criandoEm: new Date().toISOString() });
  }

  const unidadeId = await createOrder(
    {
      cityId: cidade,
      targetIds: disponiveis,
      goalLocationNum: disponiveis.length,
      startDate: data,
      endDate: data,
      durationInSecond: estado.duracao,
      frequency: frequencia,
      hours: horas,
    },
    cfg,
  );
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
    // Solta a marca para o próximo ciclo poder tentar, em vez de esperar ela
    // vencer sozinha.
    if (!ensaio) {
      await gravarEstado(caminho, { ...estado, criandoEm: undefined }).catch(() => {});
    }
    throw e;
  }
  log(`grupo ${estado.grupoId} amarrado à unidade`);

  // O plano nasce sem nome útil, e quem opera precisa achá-lo na lista pela
  // data em que aquilo vai ao ar. Falhar aqui não derruba o agendamento: a
  // veiculação já está de pé, e nome errado se conserta no portal.
  const nome = nomeDoPlano(data);
  try {
    await renomearPlano(unidadeId, nome, cfg);
    log(`plano renomeado para "${nome}"`);
  } catch (e) {
    log(`não consegui renomear o plano para "${nome}": ${e instanceof Error ? e.message : String(e)}`);
  }

  const detalhe = await getOrderDetail(unidadeId, cfg);
  const travadas = detalhe.orderItems[0]?.reservedLocationIds?.length ?? 0;
  log(`unidade ${detalhe.orderStatus} · ${detalhe.startDate} → ${detalhe.endDate} · ${travadas} tela(s)`);

  if (ensaio) {
    log("ensaio: registro do dia preservado — cancele a unidade no portal ao terminar");
  } else {
    await gravarEstado(caminho, {
      ...estado,
      unidadeId,
      agendadoEm: new Date().toISOString(),
      telas: travadas,
      criandoEm: undefined,
    });
    log("estado do dia atualizado");
  }

  return {
    estado: "agendado",
    data,
    grupoId: estado.grupoId,
    unidadeId,
    telas: travadas,
    situacao: detalhe.orderStatus,
  };
}

/**
 * Agenda o clima do dia, se houver o que agendar.
 *
 * Sair com `pendente` ou `sem-registro` é normal, não é falha: significa que a
 * aprovação no portal ainda não aconteceu. Erro lançado é problema de verdade —
 * criativo reprovado, inventário insuficiente ou falha de chamada.
 */
export async function agendarClima(opts: OpcoesAgendamento = {}): Promise<ResultadoAgendamento> {
  const cfg = opts.cfg ?? kumaConfig();
  const log = opts.log ?? (() => {});
  const cidade = opts.cidade ?? process.env.KUMA_CLIMA_CIDADE ?? CIDADE_PADRAO;
  const frequencia = opts.frequencia ?? Number(process.env.KUMA_CLIMA_FREQUENCIA ?? FREQUENCIA_PADRAO);
  const simular = opts.simular ?? false;
  const horas = opts.horas ?? horasDaJanela(process.env.KUMA_CLIMA_JANELA);

  const datas = datasCandidatas(opts.data);
  for (const data of datas) {
    const r = await processar(data, {
      cfg,
      log,
      cidade,
      frequencia,
      simular,
      horas,
      grupo: opts.grupo,
    });
    if (r) return r;
  }
  log(`nada a agendar em ${datas.join(" nem ")}`);
  return { estado: "sem-registro", datas };
}

/** Uma linha legível para log e para a tela do navegador. */
export function descreverResultado(r: ResultadoAgendamento): string {
  switch (r.estado) {
    case "agendado":
      return `Clima de ${r.data} agendado na unidade ${r.unidadeId} — ${r.telas} tela(s) travada(s).`;
    case "ja-agendado":
      return `O clima de ${r.data} já está na unidade ${r.unidadeId}.`;
    case "pendente":
      return `O criativo de ${r.data} ainda está ${r.auditoria} na Análise Criativa.`;
    case "simulado":
      return `Simulação: ${r.data} criaria unidade em ${r.telasDisponiveis} tela(s).`;
    case "sem-registro":
      return `Nenhum clima submetido para ${r.datas.join(" nem ")}.`;
  }
}
