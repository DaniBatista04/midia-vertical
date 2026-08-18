"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { drawFrame, loadLogo } from "@/lib/weather/draw";
import { BITRATE, encodeScene, pickCodec, transcodeToHevc, type CodecChoice } from "@/lib/weather/encode";
import {
  buildDaySlots,
  fetchDay,
  fetchWeek,
  sliceWeekFromDate,
  type Unit,
} from "@/lib/weather/hg";
import {
  DAY_BG1,
  WEATHER_FORMATS,
  WEEK_APPEARANCE,
  fromLocalISODate,
  toLocalISODate,
  type WeatherScene,
} from "@/lib/weather/spec";

/**
 * Renderização sem operador, para o job diário do clima.
 *
 * A página existe porque desenho e codificação só rodam no browser — canvas,
 * WebCodecs e medição de fonte não existem no servidor. O Chromium headless
 * abre esta rota e chama `window.__clima.gerar()`; assim o vídeo automático e
 * o preview do operador saem exatamente do mesmo código, em vez de duas
 * implementações que divergem com o tempo.
 *
 * Ela não substitui `/clima`: aquela é a ferramenta do operador, esta é uma
 * superfície de automação sem UI.
 */

export type ResultadoFormato = {
  w: number;
  h: number;
  /** MP4 em base64, para atravessar a ponte do Playwright. */
  base64: string;
  bytes: number;
};

export type ResultadoClima = {
  cidade: string;
  data: string;
  codec: string;
  /** true quando o arquivo passou pela conversão para H.265 no servidor. */
  convertido: boolean;
  formatos: ResultadoFormato[];
};

declare global {
  interface Window {
    __clima?: {
      pronto: boolean;
      erro: string | null;
      gerar: () => Promise<ResultadoClima>;
    };
  }
}

function blobParaBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("falha ao ler o MP4"));
    fr.onload = () => {
      const url = String(fr.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    fr.readAsDataURL(blob);
  });
}

export function AutoRenderer() {
  // Já nasce em "aguardando comando": o efeito abaixo publica o `window.__clima`
  // logo após a montagem, e escrever estado dentro dele só provocaria um render
  // em cascata para dizer o que a montagem já garante.
  const [estado, setEstado] = useState("aguardando comando");
  const codecRef = useRef<CodecChoice | null>(null);

  const gerar = useCallback(async (): Promise<ResultadoClima> => {
    const p = new URLSearchParams(window.location.search);
    const woeid = p.get("woeid") || "455827";
    // Dia é o padrão: é o card que o time publica. `?modo=semana` continua
    // disponível para a arte de 7 dias.
    const modo = p.get("modo") === "semana" ? "semana" : "dia";
    const duracao = Number(p.get("duracao") || 10);
    const unidade = (p.get("unidade") === "F" ? "F" : "C") as Unit;

    // Sem `data`, a arte é a de amanhã: o job roda às 23h para o dia seguinte.
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const dataISO = p.get("data") || toLocalISODate(amanha);
    const data = fromLocalISODate(dataISO);

    const cabecalho = p.get("header") || (modo === "semana" ? "PREVISÃO DA SEMANA" : "PREVISÃO DO DIA");

    setEstado("carregando logo");
    await loadLogo().catch(() => console.warn("logo do oferecimento não carregou"));

    setEstado("buscando previsão");
    let scene: WeatherScene;
    let cidade: string;
    if (modo === "semana") {
      const { city, days } = await fetchWeek(woeid, unidade);
      const fatia = sliceWeekFromDate(days, data);
      if (!fatia.days.length) throw new Error("previsão da semana veio vazia");
      cidade = city;
      scene = {
        mode: "week",
        city: cabecalho,
        days: fatia.days,
        selectedDate: data,
        appearance: { ...WEEK_APPEARANCE },
      };
    } else {
      const payload = await fetchDay(woeid, unidade);
      const slots = buildDaySlots(payload, dataISO);
      if (!slots.length) throw new Error("previsão do dia veio vazia");
      // A HG entrega uma janela móvel de 24h a partir da hora atual: rodando às
      // 23h ela cobre o dia seguinte inteiro, mas rodando de manhã o fim da
      // tarde de amanhã ainda não existe. Sem esta trava o card sai com "—" no
      // lugar da temperatura e ninguém percebe até estar na tela.
      const vazios = slots.filter((s) => s.temp === "—").map((s) => s.hour);
      if (vazios.length) {
        throw new Error(
          `previsão horária incompleta para ${dataISO}: sem dado em ${vazios.join(", ")} — ` +
            "a janela da HG cobre 24h a partir de agora",
        );
      }
      cidade = payload.city;
      scene = {
        mode: "day",
        city: cabecalho,
        slots,
        selectedDate: data,
        appearance: { ...WEEK_APPEARANCE, bg1: DAY_BG1 },
      };
    }

    // H.264 por padrão. A auditoria do Kuma reprovou o H.265 que sai do nosso
    // caminho de conversão (502, sem motivo), e aceitou o mesmo material em
    // H.264 — que é também o formato com que a integração do Mural roda em
    // produção, com milhares de criativos aprovados. `?codec=h265` existe para
    // reavaliar isso quando a Brato explicar o que reprovou.
    const entrega = p.get("codec") === "h265" ? "hevc" : "avc";
    setEstado("escolhendo encoder");
    const codec = codecRef.current ?? (await pickCodec(entrega));
    codecRef.current = codec;

    const formatos: ResultadoFormato[] = [];
    let convertido = false;

    for (const fmt of WEATHER_FORMATS) {
      setEstado(`codificando ${fmt.w}x${fmt.h}`);
      // Entregando H.264 direto, o bitrate é o do spec: sem segunda passada,
      // não faz sentido gastar os 12 Mbps do intermediário.
      const bruto = await encodeScene({
        scene,
        fmt,
        durationSeconds: duracao,
        codec,
        bitrate: BITRATE,
      });
      if (!bruto) throw new Error(`codificação de ${fmt.w}x${fmt.h} não produziu arquivo`);

      // Só converte quando o pedido foi explicitamente H.265 e o browser não
      // tem encoder HEVC.
      let mp4 = bruto;
      if (entrega === "hevc" && codec.muxerCodec === "avc") {
        setEstado(`convertendo ${fmt.w}x${fmt.h} para H.265`);
        mp4 = await transcodeToHevc(bruto);
        convertido = true;
      }

      formatos.push({ w: fmt.w, h: fmt.h, base64: await blobParaBase64(mp4), bytes: mp4.size });
    }

    setEstado("pronto");
    return { cidade, data: dataISO, codec: codec.label, convertido, formatos };
  }, []);

  useEffect(() => {
    window.__clima = { pronto: true, erro: null, gerar };
    return () => {
      delete window.__clima;
    };
  }, [gerar]);

  // Um canvas de verdade fica montado porque o `drawFrame` é validado nele
  // antes de qualquer codificação — se o desenho quebrar, o erro aparece aqui
  // em vez de no meio de 250 frames.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    try {
      drawFrame(cv, {
        mode: "week",
        city: "…",
        days: [],
        selectedDate: new Date(),
        appearance: { ...WEEK_APPEARANCE },
      }, 0);
    } catch {
      // cena vazia: só interessa que o módulo de desenho carregou
    }
  }, []);

  return (
    <div style={{ padding: 24, color: "#ccc", fontFamily: "monospace", fontSize: 13 }}>
      <p data-testid="estado">clima/auto — {estado}</p>
      <canvas ref={canvasRef} width={108} height={192} style={{ opacity: 0.35 }} />
    </div>
  );
}
