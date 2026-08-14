/**
 * Texto com tracking no canvas.
 *
 * ctx.letterSpacing preserva o kerning da fonte (igual ao Illustrator).
 * Onde não existir, cai no desenho glifo a glifo.
 */

export const HAS_LETTER_SPACING = (() => {
  if (typeof document === "undefined") return false;
  try {
    return "letterSpacing" in document.createElement("canvas").getContext("2d")!;
  } catch {
    return false;
  }
})();

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

export function setFont(
  ctx: CanvasRenderingContext2D,
  weight: number,
  sizePx: number,
  trackPerMille: number,
) {
  ctx.font = `${weight} ${sizePx}px InterCard, sans-serif`;
  if (HAS_LETTER_SPACING) {
    (ctx as Ctx).letterSpacing = `${(trackPerMille / 1000) * sizePx}px`;
  }
}

export function measureTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  trackPx: number,
): number {
  if (HAS_LETTER_SPACING) {
    const w = ctx.measureText(text).width;
    // O Chrome inclui o tracking depois do último glifo; descontamos.
    return text.length ? w - trackPx : 0;
  }
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + trackPx;
  return text.length ? w - trackPx : 0;
}

export function fillTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  baselineY: number,
  trackPx: number,
) {
  if (HAS_LETTER_SPACING) {
    ctx.fillText(text, x, baselineY);
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, baselineY);
    cx += ctx.measureText(ch).width + trackPx;
  }
}

export function wrapTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  trackPx: number,
): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!lines.length) {
      lines.push(word);
      continue;
    }
    const cand = `${lines[lines.length - 1]} ${word}`;
    if (measureTracked(ctx, cand, trackPx) <= maxW) lines[lines.length - 1] = cand;
    else lines.push(word);
  }

  // Palavra sozinha maior que a linha: quebra no caractere.
  const out: string[] = [];
  for (const ln of lines) {
    if (measureTracked(ctx, ln, trackPx) <= maxW) {
      out.push(ln);
      continue;
    }
    let cur = "";
    for (const ch of ln) {
      if (cur && measureTracked(ctx, cur + ch, trackPx) > maxW) {
        out.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Nome de arquivo sem acento, sem símbolo e em minúsculas. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 55)
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}
