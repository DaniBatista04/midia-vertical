import type { NextRequest } from "next/server";

import { dataEmSaoPaulo, FREQUENCIA_PADRAO } from "@/lib/kuma/agendar";
import {
  caminhoGrade,
  cortesDoDia,
  cortesValidos,
  estrategiaDaHora,
  horaEmSaoPaulo,
  inicioDoDia,
  inicioValido,
  MAX_CAIXAS,
  vagasPorCaixa,
  type GradeNoticias,
} from "@/lib/kuma/noticiaCaixas";
import { caminhoPlanoNoticias, type PlanoNoticias } from "@/lib/kuma/noticiaPlano";
import { enviosDoDia, GRACA_SEGUNDOS } from "@/lib/kuma/publicarNoticia";
import { lerJson, uploadPublico } from "@/lib/server/supabaseUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O dia das notícias como o painel desenha: as caixas, os horários de troca e
 * em que ponto cada envio está.
 *
 * `GET` lê; `PUT` muda os horários de troca de um dia que já tem notícia
 * enviada. Quem vira a caixa é o cron de minuto (`/api/noticias/agendar`), que
 * lê a mesma grade — mudar um horário aqui chega à estratégia na volta seguinte.
 */

export type EtapaEnvio = "propagando" | "em-aprovacao" | "no-plano" | "parado" | "retirada";

export type EnvioDoDia = {
  id: string;
  titulo: string;
  caixa: number;
  etapa: EtapaEnvio;
  /** Está na estratégia mandada ao Kuma por último. */
  noAr: boolean;
  miniatura?: string;
  erro?: string;
  /**
   * Enquanto sobe: quando o grupo criativo deve ir para a Análise Criativa,
   * passada a folga de propagação. É o "falta quanto?" do painel.
   */
  submeteEm?: string;
  /** Quando a notícia entrou na etapa em que está. */
  desde?: string;
};

export type DiaNoticias = {
  data: string;
  /** Hora de São Paulo, fracionária. */
  hora: number;
  vagas: number;
  maxCaixas: number;
  /** Cortes gravados para o dia, ou `null` quando vale a divisão padrão. */
  cortesGravados: number[] | null;
  /** Cortes que o cron está usando agora, para o número de caixas do plano. */
  cortes: number[];
  /** Hora em que a caixa 1 entra; antes dela fica a última. */
  inicio: number;
  caixaNoAr: number | null;
  unidadeId: string | null;
  envios: EnvioDoDia[];
};

function dataPedida(req: NextRequest): string | null {
  const data = req.nextUrl.searchParams.get("data") ?? dataEmSaoPaulo(0);
  return /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null;
}

export async function GET(req: NextRequest) {
  const data = dataPedida(req);
  if (!data) return Response.json({ error: "Data inválida — use YYYY-MM-DD." }, { status: 400 });

  try {
    const [{ envios }, grade, plano] = await Promise.all([
      enviosDoDia(data),
      lerJson<GradeNoticias>(caminhoGrade(data)),
      lerJson<PlanoNoticias>(caminhoPlanoNoticias(data)),
    ]);

    const frequencia = Number(process.env.KUMA_CLIMA_FREQUENCIA ?? FREQUENCIA_PADRAO);
    const hora = horaEmSaoPaulo();
    const noAr = new Set(plano?.estrategia ?? []);
    const agora = plano?.grupos.length ? estrategiaDaHora(plano, grade, hora) : null;
    const caixas = Math.max(1, ...envios.filter((e) => !e.erro && !e.retiradaEm).map((e) => e.caixa ?? 1));

    const corpo: DiaNoticias = {
      data,
      hora,
      vagas: vagasPorCaixa(frequencia),
      maxCaixas: MAX_CAIXAS,
      cortesGravados: grade?.cortes ?? null,
      cortes: cortesDoDia(grade, caixas),
      inicio: inicioDoDia(grade),
      caixaNoAr: agora?.caixa ?? null,
      unidadeId: plano?.unidadeId ?? null,
      envios: envios.map((e) => ({
        id: e.id,
        titulo: e.titulo,
        caixa: e.caixa ?? 1,
        etapa: e.retiradaEm ? "retirada" : e.erro ? "parado" : e.unidadeId ? "no-plano" : e.grupoId ? "em-aprovacao" : "propagando",
        noAr: Boolean(e.grupoId && noAr.has(e.grupoId)),
        miniatura: e.materiais[0],
        ...(e.erro ? { erro: e.erro } : {}),
        ...(!e.grupoId && !e.erro && !e.retiradaEm
          ? { submeteEm: new Date(Date.parse(e.hospedadoEm) + GRACA_SEGUNDOS * 1_000).toISOString() }
          : {}),
        desde: e.retiradaEm ?? e.agendadoEm ?? e.submetidoEm ?? e.hospedadoEm,
      })),
    };
    return Response.json(corpo);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const data = dataPedida(req);
  if (!data) return Response.json({ error: "Data inválida — use YYYY-MM-DD." }, { status: 400 });

  let cortes: unknown;
  let inicio: unknown;
  try {
    ({ cortes, inicio } = (await req.json()) as { cortes?: unknown; inicio?: unknown });
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }
  if (inicio !== undefined && !inicioValido(inicio)) {
    return Response.json({ error: `Início do pack 1 inválido: ${JSON.stringify(inicio)}.` }, { status: 400 });
  }
  const n = Array.isArray(cortes) ? cortes.length + 1 : 0;
  if (!cortesValidos(cortes, n, inicio as number | undefined)) {
    return Response.json({ error: `Horários inválidos: ${JSON.stringify(cortes)}.` }, { status: 400 });
  }

  /*
   * A grade precisa de janela para toda caixa que já tem notícia. Uma grade
   * mais curta seria ignorada pelo cron (ver `cortesDoDia`), e o painel ficaria
   * mostrando horários que não são os do ar.
   */
  const { envios } = await enviosDoDia(data);
  const caixas = Math.max(1, ...envios.filter((e) => !e.erro && !e.retiradaEm).map((e) => e.caixa ?? 1));
  if (n < caixas) {
    return Response.json(
      { error: `O dia tem ${caixas} pack(s) com notícia, e os horários descrevem ${n}.` },
      { status: 409 },
    );
  }

  const grade: GradeNoticias = {
    data,
    cortes,
    ...(inicio !== undefined ? { inicio } : {}),
    atualizadoEm: new Date().toISOString(),
  };
  await uploadPublico({
    caminho: caminhoGrade(data),
    conteudo: Buffer.from(JSON.stringify(grade, null, 2)),
    contentType: "application/json",
  });
  return Response.json({ ok: true, ...grade });
}
