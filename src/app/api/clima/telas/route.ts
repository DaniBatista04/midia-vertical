import type { NextRequest } from "next/server";

import { dataEmSaoPaulo, CIDADE_PADRAO } from "@/lib/kuma/agendar";
import {
  descreverAuditoria,
  getBuildings,
  getCreativeGroup,
  getOrderDetail,
  getValidLocations,
  kumaConfig,
} from "@/lib/kuma/client";
import { caminhoEstado, type EstadoDoDia } from "@/lib/kuma/estado";
import { lerJson } from "@/lib/server/supabaseUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Catálogo da cidade inteira: oito páginas de prédio e dezesseis de tela. */
export const maxDuration = 300;

/**
 * Quais telas o clima de um dia realmente alcançou, prédio por prédio.
 *
 * Existe por causa de uma pergunta que o campo faz e que nada aqui respondia:
 * em 08/09/2026 dois condomínios reportaram previsão da véspera enquanto
 * outros estavam certos, e do nosso lado só havia um número agregado — "8.097
 * telas travadas" — que não diz **quais**. Sem isso a conversa termina em
 * palpite: quem olha o registro do dia vê um total e quem olha a tela vê o
 * card errado, e não há como cruzar as duas coisas.
 *
 * A rota cruza três leituras, todas do Kuma e todas somente de leitura:
 *
 *  - o registro do dia, que diz qual unidade é a do clima daquela data;
 *  - `getOrderDetail`, que diz quais `locationId` a unidade travou;
 *  - o catálogo (`getBuildingInfos` + `getValidLocationInfos`), que diz quais
 *    telas existem na cidade e a que prédio cada uma pertence.
 *
 * O que interessa é a diferença: tela que existe no catálogo e **não** está na
 * unidade é tela que não recebeu o card do dia. Se a lista vier vazia, a
 * divergência que o campo vê não nasceu no pedido — nasceu depois dele, no
 * Liberar do portal ou na sincronização de cada player, e é lá que se procura.
 *
 * Uso:
 *
 *   /api/clima/telas                          o dia de hoje, só o resumo
 *   /api/clima/telas?data=2026-09-07          outro dia
 *   /api/clima/telas?predio=amelia            detalhe dos prédios que casam
 *   /api/clima/telas?unidade=101147_57932     unidade explícita, sem registro
 *
 * O filtro de prédio ignora acento e caixa, porque o nome chega escrito de
 * formas diferentes ("PACO DE HYGIENOPOLIS" no WhatsApp, "Paço de Hygienópolis"
 * no catálogo) e conferir isso à mão é justamente o trabalho que a rota evita.
 *
 * Sem filtro a resposta é só contagem mais a lista de telas de fora, porque a
 * cidade inteira são oito mil telas e ninguém lê isso — nem cabe no corpo de
 * uma resposta sem virar outro problema.
 */

/** Compara nome de prédio sem acento e sem caixa. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .trim();
}

/** Quantos prédios por chamada de catálogo. O mesmo lote do agendamento. */
const PREDIOS_POR_LOTE = 100;

/**
 * O `lastmod` da auditoria em ISO, no fuso de quem opera.
 *
 * É o único carimbo que existe da **aprovação manual**, e é o que fecha a linha
 * do tempo do dia: submetido às 23h, aprovado às X, unidade criada às Y. Sem
 * ele a conversa sobre atraso fica entre "o time demorou" e "a automação
 * demorou", sem ninguém poder mostrar qual foi.
 *
 * A API não documenta a unidade do campo, e os dois formatos aparecem em
 * gateway assim — segundo e milissegundo. Um `lastmod` em segundos lido como
 * milissegundo cai em 1970, então o corte é pelo tamanho.
 */
function carimbo(lastmod: number | undefined): string | undefined {
  if (!lastmod || !Number.isFinite(lastmod)) return undefined;
  const ms = lastmod < 1e12 ? lastmod * 1_000 : lastmod;
  return new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const data = params.get("data") ?? dataEmSaoPaulo(0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ error: "Data inválida — use YYYY-MM-DD." }, { status: 400 });
  }
  const filtro = params.get("predio")?.trim() || null;
  const cidade = params.get("cidade") ?? process.env.KUMA_CLIMA_CIDADE ?? CIDADE_PADRAO;

  try {
    const cfg = kumaConfig();

    // A unidade pode vir na URL — serve para conferir um dia cujo registro já
    // foi limpo, ou uma unidade criada à mão no portal.
    const registro = await lerJson<EstadoDoDia>(caminhoEstado(data));
    const unidadeId = params.get("unidade") ?? registro?.unidadeId;
    if (!unidadeId) {
      return Response.json(
        {
          error:
            `Não sei qual é a unidade do clima de ${data}: ` +
            (registro
              ? "o registro do dia existe mas ainda não tem unidade — o criativo não foi agendado."
              : "não existe registro para esta data.") +
            " Passe ?unidade= se souber o número.",
          data,
          grupoId: registro?.grupoId,
        },
        { status: 404 },
      );
    }

    // A auditoria é acessório: se ela falhar, o resto da resposta — que é a
    // pergunta principal, quais telas foram alcançadas — continua valendo.
    const auditoria = registro?.grupoId
      ? await getCreativeGroup(registro.grupoId, cfg).catch((e) => {
          console.error(`[clima/telas] auditoria de ${registro.grupoId} não veio: ${e}`);
          return null;
        })
      : null;

    const pedido = await getOrderDetail(unidadeId, cfg);
    /*
     * `reservedLocationIds` é o que a unidade travou de fato e é a resposta
     * certa enquanto ela está no ar. Só que o Kuma **esvazia essa lista quando
     * a unidade termina**: consultar o clima de ontem devolve zero travadas e
     * as 8.098 telas da cidade como "fora da unidade", o que lê exatamente
     * como a falha catastrófica que não houve. Medido em 08/09/2026, na
     * unidade `101147_57864` de 07/09, já em `FINISH`.
     *
     * Então lista vazia cai para `targetIds`, que é o que a unidade pediu e
     * continua lá depois do fim — e a resposta diz de qual dos dois campos o
     * número saiu, para ninguém comparar dia no ar com dia encerrado sem
     * saber que são medidas diferentes.
     */
    const naUnidade = new Set<string>();
    let fonte: "reservedLocationIds" | "targetIds" = "reservedLocationIds";
    for (const item of pedido.orderItems) {
      for (const id of item.reservedLocationIds ?? []) naUnidade.add(id);
    }
    if (!naUnidade.size) {
      fonte = "targetIds";
      for (const item of pedido.orderItems) {
        for (const id of item.targetIds ?? []) naUnidade.add(id);
      }
    }

    const todos = await getBuildings(cidade, cfg);
    const alvo = filtro
      ? todos.filter((p) => normalizar(p.buildingName).includes(normalizar(filtro)))
      : todos;

    const telas = [];
    for (let i = 0; i < alvo.length; i += PREDIOS_POR_LOTE) {
      const lote = alvo.slice(i, i + PREDIOS_POR_LOTE).map((p) => p.buildingId);
      telas.push(...(await getValidLocations(cidade, lote, cfg)));
    }

    const porEstilo: Record<string, { telas: number; naUnidade: number }> = {};
    for (const t of telas) {
      const chave = t.deviceStyleName || t.deviceStyleId || "?";
      const e = (porEstilo[chave] ??= { telas: 0, naUnidade: 0 });
      e.telas += 1;
      if (naUnidade.has(t.locationId)) e.naUnidade += 1;
    }

    // Agrupa por prédio para a resposta falar a língua de quem reclamou: a
    // queixa vem por nome de condomínio, não por `locationId`.
    const predios = new Map<
      string,
      {
        buildingId: string;
        buildingName: string;
        telas: { locationId: string; estilo: string; local: string; naUnidade: boolean }[];
      }
    >();
    for (const t of telas) {
      const p = predios.get(t.buildingId) ?? {
        buildingId: t.buildingId,
        buildingName: t.buildingName,
        telas: [],
      };
      p.telas.push({
        locationId: t.locationId,
        estilo: t.deviceStyleName || t.deviceStyleId,
        local: t.locationDesc,
        naUnidade: naUnidade.has(t.locationId),
      });
      predios.set(t.buildingId, p);
    }

    const lista = [...predios.values()].sort((a, b) => a.buildingName.localeCompare(b.buildingName, "pt-BR"));
    const fora = lista
      .map((p) => ({ ...p, telas: p.telas.filter((t) => !t.naUnidade) }))
      .filter((p) => p.telas.length);

    return Response.json({
      ok: true,
      data,
      unidade: {
        id: unidadeId,
        situacao: pedido.orderStatus,
        periodo: `${pedido.startDate} → ${pedido.endDate}`,
        travadas: naUnidade.size,
        fonte,
      },
      aviso:
        fonte === "targetIds"
          ? "A unidade não devolveu telas travadas (é o que acontece depois que ela " +
            "encerra), então a conta usou as telas que ela pediu. Serve para saber o " +
            "alcance pretendido, não para auditar o que foi travado no dia."
          : undefined,
      grupoId: registro?.grupoId,
      /**
       * A linha do tempo do dia, que é o que se discute quando o card chega
       * tarde na tela. Os três carimbos vêm de fontes diferentes: os dois das
       * pontas são nossos (o registro do dia) e o do meio é do Kuma — o único
       * sinal que existe de quando alguém apertou "Passar" no portal.
       */
      linhaDoTempo: auditoria
        ? {
            submetido: carimbo(Date.parse(registro?.submetidoEm ?? "")),
            aprovado: carimbo(auditoria.audit.lastmod),
            situacaoAuditoria: descreverAuditoria(auditoria.audit.status),
            unidadeCriada: carimbo(Date.parse(registro?.agendadoEm ?? "")),
          }
        : undefined,
      agendadoEm: registro?.agendadoEm,
      resumo: {
        cidade,
        prediosNoCatalogo: todos.length,
        prediosConferidos: alvo.length,
        telasConferidas: telas.length,
        telasNaUnidade: telas.filter((t) => naUnidade.has(t.locationId)).length,
        telasFora: telas.filter((t) => !naUnidade.has(t.locationId)).length,
        prediosComTelaFora: fora.length,
      },
      porEstilo,
      foraDaUnidade: fora,
      // O detalhe completo só sai com filtro: sem ele são milhares de linhas.
      predios: filtro ? lista : undefined,
    });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    console.error(`[clima/telas] FALHOU: ${mensagem}`);
    return Response.json({ ok: false, error: mensagem }, { status: 500 });
  }
}
