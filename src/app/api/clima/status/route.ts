import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Como foi a noite: os runs da fase 1 que saíram depois de um instante.
 *
 * **Por que esta rota existe, se a API do GitHub é pública.** O alarme das 23h
 * (`docs/n8n/clima-23h.json`) esperava 70 minutos e consultava
 * `api.github.com/.../runs` direto do n8n, sem token — o repositório é público
 * e a rota de runs responde anônima. Responde, mas com o orçamento anônimo de
 * **60 requisições por hora por IP**, e o IP é o de saída da instância do n8n,
 * compartilhado com quem mais estiver lá dentro. Em 11/09/2026 a consulta tomou
 * `403 API rate limit exceeded` tendo gasto duas requisições na noite: o teto
 * foi consumido por vizinhos. O erro é intermitente por natureza — depende do
 * movimento de terceiros —, então ele não aparece em teste e aparece na
 * madrugada.
 *
 * Requisição autenticada tem 5000/h, e o servidor já é autenticado: o
 * `GITHUB_DISPATCH_TOKEN` que dispara o workflow em `/api/clima/publicar` tem
 * `actions: write`, que inclui ler. Consultar daqui usa o token que já existe,
 * em vez de somar um segundo segredo ao n8n — numa instância onde a credencial
 * errada já foi amarrada no nó uma vez, ter **uma** credencial no fluxo vale
 * mais que a economia de uma rota.
 *
 * A resposta mantém a chave `workflow_runs` e os nomes de campo do GitHub de
 * propósito: o nó `Avalia o resultado` lê `workflow_runs[].status`,
 * `.conclusion`, `.id`, `.html_url` e `.created_at`, e continua lendo sem
 * mudança. O que sai é o resto — um run do GitHub traz dezenas de URLs de API
 * que ninguém do outro lado abre.
 *
 * Ela está na lista de públicas do `src/proxy.ts` porque o n8n não tem cookie,
 * e como `/api/clima/publicar` **não** fica aberta: exige o mesmo `Bearer`, que
 * é o mesmo dos dois nós do fluxo.
 */

/**
 * `owner/repo` e workflow — os mesmos de `/api/clima/publicar`, que é quem
 * cria os runs que esta rota lê. Ambos saem da mesma variável de ambiente, com
 * o mesmo padrão, para não existir a noite em que um dispara num repositório e
 * o outro procura em outro.
 */
const REPO = process.env.GITHUB_REPO ?? "DaniBatista04/midia-vertical";
const WORKFLOW = "clima-diario.yml";

/** O que o alarme lê de cada run. O resto do objeto do GitHub fica fora. */
type Run = {
  id: number;
  html_url: string;
  created_at: string;
  status: string | null;
  conclusion: string | null;
  display_title: string;
};

function segredoConfere(recebido: string, esperado: string | undefined): boolean {
  // Segredo não configurado nunca vira "qualquer um passa".
  if (!esperado) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const recebido = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Os dois são conferidos sempre, sem curto-circuito, para o tempo de resposta
  // não contar qual deles bateu.
  const daVercel = segredoConfere(recebido, process.env.CRON_SECRET);
  const deFora = segredoConfere(recebido, process.env.CLIMA_DISPATCH_TOKEN);
  if (!recebido || !(daVercel || deFora)) {
    // A recusa nomeia qual das três formas de errar foi, como em
    // `/api/clima/publicar` e pelo mesmo motivo: um 401 mudo aqui manda quem
    // está de madrugada conferir a variável errada. Nenhuma das frases conta
    // nada que o chamador já não tenha — o formato do cabeçalho está neste
    // arquivo, num repositório público —, e o token recebido não entra em
    // nenhuma delas.
    const motivo = !auth
      ? "sem cabeçalho Authorization"
      : !auth.startsWith("Bearer ")
        ? 'o cabeçalho Authorization não começa com "Bearer "'
        : "o token do Bearer não é o CRON_SECRET nem o CLIMA_DISPATCH_TOKEN";
    console.error(`[status] recusado: ${motivo}.`);
    return Response.json({ error: `Não autenticado — ${motivo}.` }, { status: 401 });
  }

  /*
   * `desde` é o instante do disparo, que o fluxo guardou antes de esperar. Sem
   * ele a consulta traria a noite anterior junto e o alarme aprovaria hoje com
   * os runs de ontem.
   *
   * O formato é conferido em vez de repassado: o valor entra na query do
   * GitHub, e um `created` que ele não entende não dá erro — dá lista inteira,
   * que é o mesmo desastre silencioso. Aceita `YYYY-MM-DD` e o instante UTC
   * completo, que é o que o nó `Marca o horario` monta.
   */
  const desde = req.nextUrl.searchParams.get("desde") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(desde)) {
    return Response.json(
      {
        error:
          `Parâmetro "desde" ausente ou fora do formato: ${desde || "(vazio)"} — ` +
          "use YYYY-MM-DD ou YYYY-MM-DDTHH:MM:SSZ.",
      },
      { status: 400 },
    );
  }

  /*
   * Quantos runs olhar. O padrão é generoso porque o custo de olhar demais é
   * zero e o de olhar de menos já cobrou: com `per_page=1` o alarme ficou cego
   * assim que passou a existir um run por praça — bastava o mais recente ter
   * dado certo. Quem decide quantos runs *esperar* é o disparo, não isto aqui.
   */
  const pedido = Number(req.nextUrl.searchParams.get("per_page") ?? 20);
  const porPagina = Number.isFinite(pedido) ? Math.min(Math.max(Math.trunc(pedido), 1), 100) : 20;

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return Response.json(
      {
        error:
          "GITHUB_DISPATCH_TOKEN não configurado no servidor — sem ele não dá para " +
          "consultar os runs do clima sem esbarrar no limite anônimo do GitHub.",
      },
      { status: 503 },
    );
  }

  const url = new URL(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`,
  );
  url.searchParams.set("event", "workflow_dispatch");
  url.searchParams.set("per_page", String(porPagina));
  url.searchParams.set("created", `>=${desde}`);

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      // Menos que o limite da função: GitHub pendurado vira função estourada,
      // e aí o alarme recebe um erro de plataforma em vez de um motivo.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const detalhe = e instanceof Error ? e.message : String(e);
    console.error(`[status] a consulta ao GitHub não completou: ${detalhe}`);
    return Response.json(
      { error: `A consulta ao GitHub não completou: ${detalhe}` },
      { status: 502 },
    );
  }

  if (!resposta.ok) {
    const detalhe = (await resposta.text()).slice(0, 300);
    console.error(`[status] GitHub recusou (${resposta.status}): ${detalhe}`);
    return Response.json(
      { error: `O GitHub recusou a consulta (HTTP ${resposta.status}). ${detalhe}` },
      { status: 502 },
    );
  }

  const corpo = (await resposta.json()) as {
    total_count?: number;
    workflow_runs?: Run[];
  };
  const runs = (corpo.workflow_runs ?? []).map((r) => ({
    id: r.id,
    html_url: r.html_url,
    created_at: r.created_at,
    status: r.status,
    conclusion: r.conclusion,
    display_title: r.display_title,
  }));

  console.log(`[status] ${runs.length} run(s) desde ${desde}.`);
  return Response.json({
    ok: true,
    desde,
    total_count: corpo.total_count ?? runs.length,
    workflow_runs: runs,
  });
}
