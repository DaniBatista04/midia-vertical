import { ArrayBufferTarget, Muxer } from "mp4-muxer";

import { drawFrame } from "./draw";
import type { WeatherFormat, WeatherScene } from "./spec";

/**
 * Exportação em MP4 via WebCodecs.
 *
 * Sem MediaRecorder e sem FFmpeg: cada frame é desenhado no instante exato
 * (i × 1000/FPS), então duração e fps são precisos por construção.
 */

export type CodecChoice = {
  codec: string;
  muxerCodec: "hevc" | "avc";
  label: string;
};

/**
 * Candidatos do melhor para o mais compatível.
 *
 * O spec do Kuma pede H.265; o H.264 fica como rede de segurança para
 * máquinas sem encoder HEVC — nesse caso o arquivo sai fora do spec e
 * precisa ser reconvertido antes de subir.
 */
export const CODEC_CANDIDATES: CodecChoice[] = [
  { codec: "hvc1.1.6.L153.B0", muxerCodec: "hevc", label: "H.265 / HEVC" },
  { codec: "hev1.1.6.L153.B0", muxerCodec: "hevc", label: "H.265 / HEVC" },
  { codec: "avc1.640033", muxerCodec: "avc", label: "H.264 High 5.1" },
  { codec: "avc1.640032", muxerCodec: "avc", label: "H.264 High 5.0" },
  { codec: "avc1.64002A", muxerCodec: "avc", label: "H.264 High 4.2" },
  { codec: "avc1.42E033", muxerCodec: "avc", label: "H.264 Baseline" },
];

export const FPS = 25;
/** 3 Mbps — abaixo do teto de 3.5 do spec de criativo. */
export const BITRATE = 3_000_000;
/**
 * Quando o browser só consegue H.264, o arquivo é um intermediário que ainda
 * vai ser re-encodado em H.265 no servidor. Sobe o bitrate para a segunda
 * passada não herdar artefato da primeira.
 */
export const INTERMEDIATE_BITRATE = 12_000_000;

/** Manda o MP4 para o servidor converter em H.265 no padrão do Kuma. */
export async function transcodeToHevc(mp4: Blob): Promise<Blob> {
  const res = await fetch("/api/transcode", {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: mp4,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Conversão falhou (HTTP ${res.status})`);
  }
  return await res.blob();
}

/**
 * Escolhe o melhor codec suportado, testando na maior resolução.
 *
 * `familia` força H.264 ou H.265 em vez de pegar o melhor disponível. O job
 * diário usa isso para entregar sempre o mesmo formato, independente de a
 * máquina ter encoder HEVC — a auditoria do Kuma reprovou nosso H.265 e aceita
 * o H.264, que é o formato com que a integração do Mural roda em produção.
 */
export async function pickCodec(familia?: "hevc" | "avc"): Promise<CodecChoice> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs não suportado — use Chrome/Edge 94+");
  }
  const candidatos = familia
    ? CODEC_CANDIDATES.filter((c) => c.muxerCodec === familia)
    : CODEC_CANDIDATES;
  for (const cand of candidatos) {
    try {
      const sup = await VideoEncoder.isConfigSupported({
        codec: cand.codec,
        width: 1080,
        height: 2560,
        bitrate: BITRATE,
        framerate: FPS,
      });
      if (sup.supported) return cand;
    } catch {
      // codec indisponível — tenta o próximo
    }
  }
  throw new Error("Nenhum codec H.264/H.265 suportado");
}

export type EncodeOptions = {
  scene: WeatherScene;
  fmt: WeatherFormat;
  durationSeconds: number;
  codec: CodecChoice;
  /**
   * Sobrescreve o bitrate. Sem isso, H.264 sai a 12 Mbps por ser um
   * intermediário que ainda vai ser reconvertido; quem entrega H.264 direto
   * precisa dos 3 Mbps do spec.
   */
  bitrate?: number;
  onProgress?: (pct: number, frame: number, total: number) => void;
  shouldCancel?: () => boolean;
};

/** Codifica um formato frame a frame e devolve o MP4 (null se cancelado). */
export async function encodeScene({
  scene,
  fmt,
  durationSeconds,
  codec,
  bitrate,
  onProgress,
  shouldCancel,
}: EncodeOptions): Promise<Blob | null> {
  const totalFrames = FPS * durationSeconds;
  const frameUs = Math.round(1_000_000 / FPS);

  // Garante que as fontes estão carregadas antes de rasterizar.
  if (document.fonts?.ready) await document.fonts.ready;

  const ec = document.createElement("canvas");
  ec.width = fmt.w;
  ec.height = fmt.h;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: codec.muxerCodec,
      width: fmt.w,
      height: fmt.h,
      frameRate: FPS,
    },
    fastStart: "in-memory", // equivalente ao -movflags +faststart
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });

  encoder.configure({
    codec: codec.codec,
    width: fmt.w,
    height: fmt.h,
    bitrate: bitrate ?? (codec.muxerCodec === "hevc" ? BITRATE : INTERMEDIATE_BITRATE),
    framerate: FPS,
    bitrateMode: "variable",
    latencyMode: "quality",
  });

  for (let i = 0; i < totalFrames; i++) {
    if (shouldCancel?.()) {
      encoder.close();
      return null;
    }
    if (encodeError) throw encodeError;

    // Tempo determinístico: cada frame corresponde a um instante exato.
    drawFrame(ec, scene, i * (1000 / FPS));

    const frame = new VideoFrame(ec, { timestamp: i * frameUs, duration: frameUs });
    encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 }); // keyframe a cada 2s
    frame.close();

    onProgress?.(((i + 1) / totalFrames) * 100, i + 1, totalFrames);

    // Backpressure: cede o controle quando a fila do encoder enche.
    if (encoder.encodeQueueSize > 8 || i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
