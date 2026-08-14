/**
 * Nome de arquivo aceito pelo Kuma.
 *
 * Duas restrições do spec de criativo mandam aqui:
 *
 *  1. `filename` não pode passar de 60 bytes em UTF-8 (limite do device).
 *  2. O nome precisa ser único entre requisições diferentes e dentro da mesma
 *     requisição — mesmo quando o material é literalmente o mesmo arquivo.
 *
 * Por isso todo nome carrega um carimbo curto de tempo + aleatório. Sem ele,
 * reenviar a mesma notícia geraria o mesmo nome e o submit seria recusado.
 */

export const KUMA_FILENAME_MAX_BYTES = 60;

export type KumaExt = "jpg" | "mp4";

const utf8 = new TextEncoder();

export function byteLength(s: string): number {
  return utf8.encode(s).length;
}

/** Corta a string em `max` bytes sem partir um caractere multibyte. */
export function truncateBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** Carimbo curto: tempo em base36 + 2 caracteres aleatórios. */
function stamp(): string {
  const rand = Math.random().toString(36).slice(2, 4).padEnd(2, "0");
  return `${Date.now().toString(36)}${rand}`;
}

/**
 * Monta `<base>-<w>x<h>-<carimbo>.<ext>`, encurtando a base até caber nos
 * 60 bytes. A base já deve vir sem acento (ver slugify).
 */
export function kumaFilename(
  base: string,
  w: number,
  h: number,
  ext: KumaExt,
): string {
  const suffix = `-${w}x${h}-${stamp()}.${ext}`;
  const room = KUMA_FILENAME_MAX_BYTES - byteLength(suffix);

  // Sem espaço para a base (nunca deve acontecer com os formatos atuais):
  // devolve só o sufixo sem o hífen inicial, que continua único e válido.
  if (room <= 0) return suffix.slice(1);

  const head = truncateBytes(base, room).replace(/-+$/, "");
  return head ? `${head}${suffix}` : suffix.slice(1);
}
