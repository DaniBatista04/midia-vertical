/**
 * O teste do `ignoreLock`: uma notícia com plano e unidade só dela, criada pelo
 * módulo novo de unidade (`unit/create`) com `ignoreLock: true`.
 *
 * ## A pergunta
 *
 * Trocar a estratégia de uma unidade viva não chega à tela sozinho — o conteúdo
 * só aparece depois do City Lock e da publicação no portal, e isso é o que
 * impede troca de notícia e de comunicado ao longo do dia. O contrato do
 * `unit/create` tem um campo `ignoreLock: boolean` sem descrição nenhuma. Este
 * teste responde se uma unidade criada com ele vai à tela sem o ciclo manual.
 *
 * ## O plano é uma "caixa" de amanhã
 *
 * `campaign/create` é recusado para a nossa conta ("-5 This campaign does not
 * support audit operations", 23/09/2026), então o plano do teste nasce pelo
 * único caminho que funciona, o `createOrder` — que cria plano e unidade juntos.
 * Essa primeira unidade vai para **amanhã**, nas mesmas telas: ela só existe
 * para o plano existir. A unidade com `ignoreLock` entra nele para **hoje**, e
 * como a de amanhã ainda não vale, hoje só ela pode levar a notícia à tela. O
 * cancelamento do teste derruba as duas.
 *
 * ## Por que um plano novo, e não uma unidade no plano do dia
 *
 * A estratégia amarra o criativo no **plano** (`orderId` é o `adCampaignId`,
 * medido em 09/09/2026 — ver `createOrder` no `client.ts`). Uma unidade de teste
 * dentro do plano das notícias do dia, com a notícia de teste amarrada, trocaria
 * as notícias da cidade inteira. Então o teste cria um plano próprio, copiando
 * do plano do dia a conta, o tipo, a cidade, a duração e a frequência, e muda só
 * duas coisas: as telas (as de um prédio) e o `ignoreLock`.
 *
 * Cada chamada ao Kuma fica no `log` do envio, com o que ele respondeu: o
 * resultado do teste é esse registro, mais o que alguém vir na tela do prédio.
 */

import {
  cancelAdUnit,
  cancelOrder,
  createAdUnit,
  createOrder,
  createOrderStrategy,
  getAdUnit,
  getCampaignUnits,
  getValidLocations,
  inquireAdUnit,
  kumaConfig,
  type KumaConfig,
} from "./client";
import { dataEmSaoPaulo } from "./agendar";
import { cidadesConfiguradas } from "./cidades";
import {
  caminhoPlanoNoticias,
  frequenciaDaNoticia,
  gruposParaEstrategia,
  type PlanoNoticias,
} from "./noticiaPlano";
import { caminhoNoticia, type EstadoNoticia, type TesteIgnoreLock } from "./noticiaEstado";
import { lerJson, uploadPublico } from "../server/supabaseUpload";

type Corpo = Record<string, unknown>;

function cfgDaNoticia(cfg?: KumaConfig): KumaConfig {
  if (cfg) return cfg;
  const conta = process.env.KUMA_BIDDER_NEWS?.trim();
  if (!conta) throw new Error("KUMA_BIDDER_NEWS não configurada — o teste iria para a conta do clima.");
  return kumaConfig(conta);
}

async function gravar(estado: EstadoNoticia): Promise<void> {
  await uploadPublico({
    caminho: caminhoNoticia(estado.id),
    conteudo: Buffer.from(JSON.stringify(estado, null, 2)),
    contentType: "application/json",
  });
}

const curto = (v: unknown) => JSON.stringify(v).slice(0, 600);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** O que interessa de `unit/get` para saber se a unidade foi ao ar. */
export function resumoDaUnidade(u: Corpo): Corpo {
  const campos = [
    "adUnitStatus", "adUnitType", "auditStatus", "published", "publishChanged",
    "publishVersion", "publishTime", "reserved", "broadcast", "targetCount",
    "startDate", "endDate", "errorTargetIds",
  ];
  return Object.fromEntries(campos.filter((c) => c in u).map((c) => [c, u[c]]));
}

/**
 * Abre o plano e a unidade do teste e amarra a notícia. Cada passo é gravado ao
 * terminar, com o id que criou: uma volta que morra no meio retoma do passo
 * seguinte na próxima, sem criar plano ou unidade em dobro.
 */
export async function abrirTeste(
  estado: EstadoNoticia & { teste: TesteIgnoreLock; grupoId: string },
  opts: { cfg?: KumaConfig; log?: (m: string) => void } = {},
): Promise<{ ok: true; planoId: string; telas: number } | { ok: false; motivo: string }> {
  const log = opts.log ?? (() => {});
  const cfg = cfgDaNoticia(opts.cfg);
  const teste: TesteIgnoreLock = { ...estado.teste, log: [...(estado.teste.log ?? [])] };
  const atual = (): EstadoNoticia => ({ ...estado, teste });
  const anotar = async (passo: string, ok: boolean, detalhe: string) => {
    teste.log.push({ em: new Date().toISOString(), passo, ok, detalhe });
    log(`${estado.id} [teste] ${passo}: ${detalhe}`);
    await gravar(atual());
  };
  const falhar = async (passo: string, e: unknown) => {
    const motivo = `teste ignoreLock — ${passo}: ${msg(e)}`;
    teste.log.push({ em: new Date().toISOString(), passo, ok: false, detalhe: msg(e) });
    await gravar({ ...atual(), erro: motivo, criandoEm: undefined });
    return { ok: false as const, motivo };
  };

  const hoje = dataEmSaoPaulo(0);

  /* ── Referência: o plano de notícias do dia ─────────────────── */
  const plano =
    (await lerJson<PlanoNoticias>(caminhoPlanoNoticias(hoje))) ??
    (await lerJson<PlanoNoticias>(caminhoPlanoNoticias(estado.data)));
  if (!plano?.unidadeId) {
    return falhar("referência", "o dia não tem plano de notícia para copiar conta, cidade e frequência");
  }

  let unidades: Corpo[];
  try {
    unidades = await getCampaignUnits(plano.unidadeId, cfg);
  } catch (e) {
    return falhar("referência", e);
  }

  /*
   * A cidade é a do prédio, não a da primeira unidade do plano: o plano de
   * notícias tem uma unidade por praça, e em 23/09/2026 o primeiro teste pegou
   * a do Rio e procurou um prédio de São Paulo lá — "nenhuma tela válida".
   * Tenta cada cidade do plano (e as configuradas) até o prédio aparecer.
   */
  const candidatas = [
    ...new Set([
      ...unidades.map((u) => String(u.cityId ?? "")).filter(Boolean),
      ...cidadesConfiguradas(process.env.KUMA_CLIMA_CIDADE),
    ]),
  ];
  let cidade = "";
  let doPredio: string[] = [];
  for (const c of candidatas) {
    try {
      doPredio = (await getValidLocations(c, [teste.predioId], cfg)).map((l) => l.locationId);
    } catch (e) {
      return falhar("telas do prédio", e);
    }
    if (doPredio.length) {
      cidade = c;
      break;
    }
  }
  if (!cidade) {
    return falhar(
      "telas do prédio",
      `o prédio ${teste.predioId} não tem tela válida em nenhuma das cidades ${candidatas.join(", ")}`,
    );
  }
  const unidadeRef = unidades.find((u) => String(u.cityId) === cidade) ?? unidades[0] ?? {};
  const duracao = Number(unidadeRef.durationInSecond ?? estado.duracao);
  const frequencia = Number(
    unidadeRef.frequency ?? frequenciaDaNoticia(),
  );
  teste.cidadeId = cidade;

  /* ── Telas: conferidas antes de criar qualquer coisa ───────── */
  // Um Point ID que não casa não pode deixar plano vazio para trás no Kuma.
  // Point ID escolhido à mão só entra se o Kuma o listar como tela válida do
  // prédio: um id que não casa criaria unidade com tela errada, ou nenhuma.
  let telas = doPredio;
  if (teste.pontos?.length) {
    const fora = teste.pontos.filter((pt) => !doPredio.includes(pt));
    if (fora.length) {
      return falhar(
        "telas do prédio",
        `Point ID ${fora.join(", ")} não está entre as telas válidas do prédio ${teste.predioId}: ` +
          doPredio.join(", "),
      );
    }
    telas = teste.pontos;
  }

  /* ── 1. Plano próprio: a "caixa" de amanhã ──────────────────── */
  if (!teste.planoId) {
    const amanha = dataEmSaoPaulo(1);
    try {
      const id = await createOrder(
        {
          itens: [{ cityId: cidade, targetIds: telas, goalLocationNum: telas.length }],
          startDate: amanha,
          endDate: amanha,
          durationInSecond: duracao,
          frequency: frequencia,
        },
        cfg,
      );
      teste.planoId = id;
      await anotar("createOrder (caixa)", true, `plano ${id} · unidade de ${amanha} em ${telas.join(", ")}`);
    } catch (e) {
      return falhar("createOrder (caixa)", e);
    }
  }

  /* ── 2. Unidade com ignoreLock ──────────────────────────────── */
  if (!teste.adUnitId) {
    const pedido = {
      adCampaignId: teste.planoId,
      adSlotName: unidadeRef.adSlotName ?? "SMART_SCREEN_FULL",
      cityId: cidade,
      adUnitTargetIds: telas,
      targetType: "LOCATION",
      goalLocationNum: telas.length,
      startDate: hoje,
      endDate: hoje,
      durationInSecond: duracao,
      frequency: frequencia,
      adUnitType: "GUARANTEED",
      dsp: false,
      ignoreLock: true,
      remark: `teste ignoreLock ${estado.id}`,
    };
    try {
      const r = await createAdUnit(pedido, cfg);
      const id = r.adUnitId ? String(r.adUnitId) : "";
      if (!id) return falhar("unit/create", `sem adUnitId na resposta: ${curto(r)}`);
      teste.adUnitId = id;
      teste.telas = telas.length;
      await anotar("unit/create", true, `unidade ${id} · ${telas.length} tela(s) · resposta ${curto(r)}`);
    } catch (e) {
      return falhar("unit/create", e);
    }
  }

  /* ── 3. Amarrar a notícia ───────────────────────────────────── */
  try {
    const lista = gruposParaEstrategia([estado.grupoId], frequencia);
    await createOrderStrategy(teste.planoId!, lista, cfg);
    await anotar("createOrderStrategy", true, `plano ${teste.planoId} ← ${lista.join(", ")}`);
  } catch (e) {
    return falhar("createOrderStrategy", e);
  }

  /* ── 4. Como a unidade ficou ────────────────────────────────── */
  try {
    const u = await getAdUnit(teste.adUnitId!, cfg);
    await anotar("unit/get", true, curto(resumoDaUnidade(u)));
  } catch (e) {
    await anotar("unit/get", false, msg(e));
  }

  await gravar({
    ...atual(),
    unidadeId: teste.planoId,
    agendadoEm: new Date().toISOString(),
    telas: teste.telas,
    criandoEm: undefined,
  });
  return { ok: true, planoId: teste.planoId!, telas: teste.telas ?? 0 };
}

/** Lê de novo a unidade do teste: `unit/get` e `unit/inquire`, anotados no log. */
export async function lerTeste(id: string, opts: { cfg?: KumaConfig } = {}): Promise<EstadoNoticia> {
  const estado = await lerJson<EstadoNoticia>(caminhoNoticia(id));
  if (!estado?.teste) throw new Error(`envio ${id} não é um teste`);
  if (!estado.teste.adUnitId) return estado;
  const cfg = cfgDaNoticia(opts.cfg);
  const teste = { ...estado.teste, log: [...estado.teste.log] };
  const agora = () => new Date().toISOString();
  try {
    const u = await getAdUnit(teste.adUnitId!, cfg);
    teste.log.push({ em: agora(), passo: "unit/get", ok: true, detalhe: curto(resumoDaUnidade(u)) });
  } catch (e) {
    teste.log.push({ em: agora(), passo: "unit/get", ok: false, detalhe: msg(e) });
  }
  try {
    const t = await inquireAdUnit(teste.adUnitId!, cfg);
    teste.log.push({ em: agora(), passo: "unit/inquire", ok: true, detalhe: curto(t) });
  } catch (e) {
    teste.log.push({ em: agora(), passo: "unit/inquire", ok: false, detalhe: msg(e) });
  }
  const novo = { ...estado, teste };
  await gravar(novo);
  return novo;
}

/**
 * Tira o erro de um teste parado, para o cron tentar de novo na volta seguinte.
 * Retoma do passo que faltou: o plano e a unidade já criados ficam no registro.
 */
export async function retomarTeste(id: string): Promise<EstadoNoticia> {
  const estado = await lerJson<EstadoNoticia>(caminhoNoticia(id));
  if (!estado?.teste) throw new Error(`envio ${id} não é um teste`);
  const novo = { ...estado, erro: undefined, criandoEm: undefined };
  await gravar(novo);
  return novo;
}

/** Cancela o teste: a unidade com `ignoreLock` e o plano-caixa com a unidade de amanhã. */
export async function cancelarTeste(id: string, opts: { cfg?: KumaConfig } = {}): Promise<EstadoNoticia> {
  const estado = await lerJson<EstadoNoticia>(caminhoNoticia(id));
  if (!estado?.teste) throw new Error(`envio ${id} não é um teste`);
  const teste = { ...estado.teste, log: [...estado.teste.log] };
  const em = new Date().toISOString();
  if (!teste.adUnitId) {
    // Ainda não tem unidade: basta o cron parar de levar o envio adiante.
    teste.canceladoEm = em;
    const novo = { ...estado, teste, retiradaEm: em };
    await gravar(novo);
    return novo;
  }
  const cfg = cfgDaNoticia(opts.cfg);
  let ok = true;
  try {
    const r = await cancelAdUnit(teste.adUnitId, cfg);
    teste.log.push({ em, passo: "unit/cancel", ok: true, detalhe: curto(r) });
  } catch (e) {
    ok = false;
    teste.log.push({ em, passo: "unit/cancel", ok: false, detalhe: msg(e) });
  }
  if (teste.planoId) {
    try {
      await cancelOrder(teste.planoId, cfg);
      teste.log.push({ em, passo: "cancelOrder (caixa)", ok: true, detalhe: `plano ${teste.planoId}` });
    } catch (e) {
      ok = false;
      teste.log.push({ em, passo: "cancelOrder (caixa)", ok: false, detalhe: msg(e) });
    }
  }
  if (ok) teste.canceladoEm = em;
  const novo = { ...estado, teste };
  await gravar(novo);
  return novo;
}
