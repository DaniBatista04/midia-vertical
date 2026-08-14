import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";

/**
 * Conversão para H.265, do jeito que o Kuma pede.
 *
 * O browser codifica em H.265 quando a máquina tem encoder de hardware. Quando
 * não tem, o WebCodecs só entrega H.264 — e aí este módulo re-encoda no
 * servidor, para o arquivo que o operador baixa já sair dentro do spec.
 */

/** Parâmetros do `creative specification.xlsx`. */
export const KUMA_VIDEO = {
  fps: 25,
  /** Alvo de 3 Mbps, com teto de 3.5 respeitando o limite da planilha. */
  targetBitrate: "3M",
  maxBitrate: "3.5M",
  bufSize: "6M",
  /** Keyframe a cada 2s — mesma cadência do encoder do browser. */
  gop: 50,
} as const;

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export class TranscodeError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "TranscodeError";
  }
}

function ffmpegBin(): string {
  if (!ffmpegPath) {
    throw new TranscodeError("ffmpeg não disponível neste ambiente.");
  }
  return ffmpegPath;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    // Guarda só o final do log: é onde ffmpeg escreve o motivo da falha.
    proc.stderr.on("data", (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new TranscodeError("Conversão excedeu o tempo limite."));
    }, timeoutMs);

    proc.on("error", (e) => {
      clearTimeout(timer);
      // Inclui o caminho: quase toda falha aqui é o binário não estar onde
      // o pacote acha que está depois do bundling.
      reject(new TranscodeError("Falha ao executar o ffmpeg.", `${bin} — ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new TranscodeError(`ffmpeg saiu com código ${code}.`, stderr));
    });
  });
}

/** Converte um MP4 (tipicamente H.264) em MP4 H.265 no padrão do Kuma. */
export async function toKumaHevc(
  input: Uint8Array,
  timeoutMs = 240_000,
): Promise<Uint8Array> {
  if (input.byteLength === 0) throw new TranscodeError("Arquivo vazio.");
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new TranscodeError("Arquivo acima do limite aceito.");
  }

  const dir = await mkdtemp(path.join(tmpdir(), "mv-transcode-"));
  const inPath = path.join(dir, `${randomBytes(6).toString("hex")}.mp4`);
  const outPath = path.join(dir, `${randomBytes(6).toString("hex")}-hevc.mp4`);

  try {
    await writeFile(inPath, input);

    await run(
      ffmpegBin(),
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", inPath,
        "-c:v", "libx265",
        "-preset", "medium",
        // hvc1 é a tag que players e devices esperam num MP4 HEVC;
        // sem ela muita tela simplesmente não reproduz.
        "-tag:v", "hvc1",
        "-pix_fmt", "yuv420p",
        "-r", String(KUMA_VIDEO.fps),
        "-b:v", KUMA_VIDEO.targetBitrate,
        "-maxrate", KUMA_VIDEO.maxBitrate,
        "-bufsize", KUMA_VIDEO.bufSize,
        "-x265-params",
        `keyint=${KUMA_VIDEO.gop}:min-keyint=${KUMA_VIDEO.gop}:scenecut=0:log-level=error`,
        "-an", // as artes não têm áudio
        "-movflags", "+faststart",
        "-y", outPath,
      ],
      timeoutMs,
    );

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
