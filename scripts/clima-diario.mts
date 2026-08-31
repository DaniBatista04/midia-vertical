/**
 * Job diário do clima: renderiza, hospeda e deposita o grupo criativo na
 * conta Weather do Kuma.
 *
 * A automação termina aí, de propósito. O time aprova em lote na Análise
 * Criativa do portal e faz o City Lock / Liberar por lá — é o processo que
 * existe hoje, e o que a API não cobre (o tipo de unidade, por exemplo, não
 * tem campo em chamada nenhuma). O ganho é as meninas encontrarem o clima do
 * dia seguinte já pronto na lista, junto com o resto que elas já aprovam.
 *
 *   npm run clima:diario -- --dry-run     monta e mostra o payload, sem enviar
 *   npm run clima:diario                  renderiza, sobe e submete
 *
 * Variáveis necessárias:
 *   APP_URL                    base pública do painel (ex.: https://conteudos.focusmedia.com.br)
 *   APP_PASSWORD               senha do painel, para o login do runner
 *   SUPABASE_URL               projeto do Supabase, onde os MP4 viram URL pública
 *   SUPABASE_SERVICE_ROLE_KEY  chave de serviço do Storage
 *   SUPABASE_BUCKET            opcional; padrão "Media"
 *   KUMA_API_URL / KUMA_API_KEY / KUMA_BIDDER_WEATHER
 *   ASSETS_URL                 opcional; de onde saem os defaults do 19" (padrão: APP_URL)
 *   CHROME_PATH                opcional; sem ela, usa o canal "chrome" instalado
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ffmpegPath from "ffmpeg-static";

import { chromium, type Browser } from "playwright-core";

import { lerJson, uploadPublico } from "../src/lib/server/supabaseUpload";
import { caminhoEstado, type EstadoDoDia } from "../src/lib/kuma/estado";

import {
  descreverAuditoria,
  getCreativeGroup,
  kumaConfig,
  submitCreativeGroup,
} from "../src/lib/kuma/client";
import { montarGrupoClima, nomeMaterial, traduzirFeedback } from "../src/lib/kuma/weatherGroup";
import { ERRO_PREVISAO_INCOMPLETA } from "../src/lib/weather/hg";
import type { ResultadoClima } from "../src/components/weather/AutoRenderer";

const APP_URL = (process.env.APP_URL ?? "").replace(/\/+$/, "");
/**
 * De onde saem os materiais default do 19". Normalmente é o próprio painel,
 * mas num ensaio local o `APP_URL` é `localhost` — e o Kuma baixa o arquivo
 * pela URL, então material em localhost reprova com 502 sem dizer o motivo.
 */
const ASSETS_URL = (process.env.ASSETS_URL ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
const DRY_RUN = process.argv.includes("--dry-run");

const arg = (nome: string): string | undefined => {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p?.slice(nome.length + 3);
};

const DURACAO = Number(arg("duracao") ?? 10);
/** Explícito ganha; sem ele, `indiceDoDia()` decide. */
const INDICE_EXPLICITO = arg("indice") ? Number(arg("indice")) : null;
const WOEID = arg("woeid") ?? "455827";
const MODO = arg("modo") ?? "dia";
/** Minutos de espera pela auditoria antes de desistir de acompanhar. */
const ESPERA_AUDITORIA = Number(arg("espera") ?? 15);
/**
 * Segundos de folga entre hospedar e submeter.
 *
 * O Kuma baixa o material logo depois da submissão, e objeto recém-subido no
 * Supabase ainda não está acessível para ele — o que a auditoria reporta como
 * 502 com feedback vazio. Medido contra a produção: falhou com 0s, 30s e 180s,
 * e o mesmo material submetido cerca de 15 minutos depois foi aprovado. Daí o
 * padrão folgado: num job das 23h, dez minutos não custam nada, e a alternativa
 * é o clima do dia seguinte não existir.
 */
const GRACA = Number(arg("graca") ?? 600);
/** Minutos de espera entre tentativas quando a HG chega sem as horas do dia. */
const ESPERA_HG = Number(arg("espera-hg") ?? 5);
/** Tentativas de render antes de desistir da previsão horária. */
const TENTATIVAS_HG = 3;
/** Prefixo no nome do grupo, para marcar envio de teste na lista do portal. */
const PREFIXO = arg("prefixo") ?? "";
/** `--cru` sobe o MP4 do browser sem passar pelo ffmpeg. Ver `normalizar()`. */
const CRU = process.argv.includes("--cru");

function log(msg: string) {
  console.log(`[clima] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

/**
 * Índice do material do dia.
 *
 * O Kuma exige nome de arquivo único **entre requisições**, e nome repetido é
 * reprovado com 502 e feedback vazio — sem dizer o motivo. O índice é o campo
 * que a convenção reserva para isso, então quando já existe registro para a
 * data (reenvio, ou tentativa anterior), o próximo envio sobe um.
 */
async function indiceDoDia(dataISO: string): Promise<number> {
  if (INDICE_EXPLICITO !== null) return INDICE_EXPLICITO;
  const anterior = await lerJson<EstadoDoDia>(caminhoEstado(dataISO)).catch(() => null);
  return anterior ? anterior.indice + 1 : 1;
}

/** Data de veiculação: amanhã, já que o job roda na véspera à noite. */
function dataVeiculacao(): Date {
  const explicita = arg("data");
  if (explicita) {
    const [y, m, d] = explicita.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

/** Faz login no painel e devolve o cookie de sessão. */
async function login(): Promise<string> {
  const res = await fetch(`${APP_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: APP_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const cookie = res.headers.getSetCookie?.()[0] ?? res.headers.get("set-cookie");
  if (!cookie) throw new Error("login não devolveu cookie de sessão");
  return cookie;
}

async function renderizar(cookie: string): Promise<ResultadoClima> {
  const executablePath = process.env.CHROME_PATH;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const [nome, valor] = cookie.split(";")[0].split("=");
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: nome, value: valor, url: APP_URL }]);
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`  [browser] ${m.text()}`);
    });

    const params = new URLSearchParams({
      woeid: WOEID,
      modo: MODO,
      duracao: String(DURACAO),
      data: dataVeiculacao().toISOString().slice(0, 10),
    });
    log(`abrindo /clima/auto?${params}`);
    await page.goto(`${APP_URL}/clima/auto?${params}`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForFunction(() => window.__clima?.pronto === true, null, { timeout: 60_000 });

    log("renderizando e codificando (pode levar alguns minutos)");
    // `evaluate` não tem timeout próprio: a codificação é frame a frame com
    // backpressure e ainda pode passar pela conversão H.265 no servidor, então
    // o limite real é o do job de CI.
    return (await page.evaluate(() => window.__clima!.gerar())) as ResultadoClima;
  } finally {
    await browser?.close();
  }
}

/**
 * Renderiza, tolerando a HG chegar sem as horas do dia pedido.
 *
 * Em 29/08/2026 o job das 23h abortou com os oito horários vazios e nenhum
 * card foi para as telas do dia 30 — e às 23h a janela de 24h da HG cobre o
 * dia seguinte inteiro, então o que faltou foi a HG ter publicado as horas,
 * não o horário do disparo. É falha que passa sozinha: esperar alguns minutos
 * e pedir de novo custa muito menos que um dia sem clima na tela.
 *
 * Só este erro é repetido. Qualquer outra falha do render sobe na hora — não
 * adianta gastar quinze minutos do job repetindo o que não vai mudar.
 */
async function renderizarComEspera(cookie: string): Promise<ResultadoClima> {
  for (let i = 1; ; i++) {
    const restam = TENTATIVAS_HG - i;
    try {
      return await renderizar(cookie);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (restam <= 0 || !msg.includes(ERRO_PREVISAO_INCOMPLETA)) throw e;
      log(msg);
      log(`esperando ${ESPERA_HG} min pela HG publicar as horas (restam ${restam} tentativas)`);
      await new Promise((r) => setTimeout(r, ESPERA_HG * 60_000));
    }
  }
}

/**
 * Re-embala o MP4 com ffmpeg antes de subir.
 *
 * Dois motivos, os dois medidos contra a produção:
 *
 *  1. **Áudio.** O arquivo do browser não tem faixa de áudio, e a auditoria
 *     reprova com 502 e feedback vazio. Todo criativo aprovado em produção
 *     carrega AAC 48 kHz — a planilha de especificação pede isso, e o
 *     validador cobra em silêncio. Aqui entra uma trilha muda.
 *  2. **Container.** O MP4 do `mp4-muxer` carrega metadados próprios; passar
 *     por ffmpeg entrega o mesmo tipo de arquivo que a integração do Mural
 *     produz e que já foi aprovado milhares de vezes.
 */
async function normalizar(entrada: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  if (!ffmpegPath) throw new Error("ffmpeg-static não disponível");
  const dir = await mkdtemp(join(tmpdir(), "clima-"));
  const src = join(dir, "in.mp4");
  const out = join(dir, "out.mp4");
  try {
    await writeFile(src, entrada);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath!, [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", src,
        // Trilha muda de 48 kHz: a arte não tem som, mas todo criativo
        // aprovado em produção carrega áudio.
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-shortest",
        // Daqui para baixo é a receita do `resizeVideo` do Mural, que produz os
        // arquivos que a auditoria aprova: aspecto explícito, libx264 em
        // ultrafast, sem bitrate fixo. Metadado do `mp4-muxer` é descartado.
        "-map_metadata", "-1",
        "-aspect", `${w}:${h}`,
        // 24 fps, e não os 25 da planilha. Medido contra a produção: o mesmo
        // material a 25 fps foi reprovado com 502 em quatro tentativas
        // seguidas, e passou a 24. Entre os criativos aprovados hoje há 24 e
        // 30 fps — 25 é o único que não passa, e a Brato não explica.
        "-r", "24",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "ultrafast",
        "-c:a", "aac", "-ar", "48000", "-b:a", "128k",
        "-y", out,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let erro = "";
      proc.stderr.on("data", (c) => { erro = (erro + c).slice(-2000); });
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu ${code}: ${erro}`))));
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function hospedar(resultado: ResultadoClima, data: Date, indice: number): Promise<{ v32: string; v25: string }> {
  const urls: Record<string, string> = {};
  for (const f of resultado.formatos) {
    const tamanho = f.h === 2560 ? "25" : "32";
    const nome = `${nomeMaterial(data, tamanho as "25" | "32", indice, DURACAO)}.mp4`;
    let buffer: Uint8Array = Buffer.from(f.base64, "base64");
    if (!CRU) {
      const antes = buffer.byteLength;
      buffer = await normalizar(buffer, f.w, f.h);
      log(`normalizado ${tamanho}" — ${(antes / 1024 / 1024).toFixed(2)} → ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    }
    // O nome já carrega data e índice, então a URL é previsível e não colide
    // entre dias — o que também deixa o material fácil de achar no bucket.
    const url = await uploadPublico({
      caminho: `clima/${nome}`,
      conteudo: buffer,
      contentType: "video/mp4",
    });
    log(`hospedado ${nome} — ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    urls[tamanho] = url;
  }
  if (!urls["25"] || !urls["32"]) throw new Error("faltou um dos formatos depois da renderização");
  return { v25: urls["25"], v32: urls["32"] };
}

async function acompanharAuditoria(id: string) {
  const limite = Date.now() + ESPERA_AUDITORIA * 60_000;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 60_000));
    const g = await getCreativeGroup(id);
    const rotulo = descreverAuditoria(g.audit.status);
    if (g.audit.status === 1) {
      log(`auditoria: ${rotulo}`);
      continue;
    }
    const detalhe = traduzirFeedback(g.audit.feedback);
    log(`auditoria: ${rotulo}${detalhe ? ` — ${detalhe}` : ""}`);
    if (g.audit.status !== 3) process.exitCode = 1;
    return;
  }
  log(`auditoria ainda pendente depois de ${ESPERA_AUDITORIA} min — o time aprova em lote no portal`);
}

async function main() {
  if (!APP_URL) throw new Error("APP_URL não definida");
  const data = dataVeiculacao();
  const dataISOprevia = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
  const INDICE = await indiceDoDia(dataISOprevia);
  log(`clima de ${data.toLocaleDateString("pt-BR")} · ${MODO} · ${DURACAO}s · índice ${INDICE}`);

  if (DRY_RUN) {
    const grupo = montarGrupoClima({
      data,
      duracao: DURACAO,
      indice: INDICE,
      video32: "https://exemplo/video-32.mp4",
      video25: "https://exemplo/video-25.mp4",
      baseUrl: ASSETS_URL,
    });
    console.log(JSON.stringify(grupo, null, 2));
    return;
  }

  if (!APP_PASSWORD) throw new Error("APP_PASSWORD não definida");
  // `--salvar` para quando o que interessa é conferir o vídeo, não publicá-lo:
  // renderiza, grava em disco e para antes de hospedar e submeter.
  const salvarEm = arg("salvar");
  const cfg = salvarEm ? null : kumaConfig();

  const dataISO = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
  const cookie = await login();
  const resultado = await renderizarComEspera(cookie);
  log(`renderizado: ${resultado.cidade} · ${resultado.codec}${resultado.convertido ? " + conversão H.265" : ""}`);

  if (salvarEm) {
    await mkdir(salvarEm, { recursive: true });
    for (const f of resultado.formatos) {
      const tamanho = f.h === 2560 ? "25" : "32";
      const nome = `${nomeMaterial(data, tamanho as "25" | "32", INDICE, DURACAO)}.mp4`;
      await writeFile(join(salvarEm, nome), Buffer.from(f.base64, "base64"));
      log(`gravado ${nome} — ${(f.bytes / 1024 / 1024).toFixed(2)} MB`);
    }
    return;
  }

  const { v25, v32 } = await hospedar(resultado, data, INDICE);
  const grupo = montarGrupoClima({
    data,
    duracao: DURACAO,
    indice: INDICE,
    video25: v25,
    video32: v32,
    baseUrl: APP_URL,
  });

  if (GRACA > 0) {
    log(`aguardando ${GRACA}s para o material propagar antes de submeter`);
    await new Promise((r) => setTimeout(r, GRACA * 1_000));
  }

  if (PREFIXO) grupo.name = `${PREFIXO}${grupo.name}`;
  // Três tentativas: o 500 de leitura do Kuma derrubou a submissão em 23/08 e
  // 30/08, e aqui não existe próxima passada — se este envio não entrar, o dia
  // seguinte amanhece sem clima nas telas.
  const enviado = await submitCreativeGroup(grupo, cfg!, 3);
  log(`grupo criativo ${enviado.id} enviado — ${descreverAuditoria(enviado.audit.status)}`);
  log(`aparece na Análise Criativa como "${grupo.name}"`);

  // O agendamento roda depois, quando o time aprovar, e precisa achar este
  // grupo. Sem banco no projeto, o registro do dia mora no próprio bucket.
  const estado: EstadoDoDia = {
    data: dataISO,
    grupoId: enviado.id,
    nomeGrupo: grupo.name ?? "",
    indice: INDICE,
    duracao: DURACAO,
    submetidoEm: new Date().toISOString(),
    materiais: grupo.creatives.flatMap((c) => c.materials.map((m) => m.filename)),
  };
  await uploadPublico({
    caminho: caminhoEstado(dataISO),
    conteudo: Buffer.from(JSON.stringify(estado, null, 2)),
    contentType: "application/json",
  });
  log(`estado do dia gravado em ${caminhoEstado(dataISO)}`);

  await acompanharAuditoria(enviado.id);
}

main().catch((e) => {
  console.error(`[clima] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
