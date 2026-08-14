/**
 * Mapa entre os device styles do Kuma e o que nós produzimos.
 *
 * O creativeGroup exige entrada para os quatro styles em toda submissão. Duas
 * telas compartilham a mesma arte (1080×1920) e o 19" — que é split e pede
 * uma arte horizontal em cima — usa material default, conforme o spec permite
 * quando não há criativo real para aquele formato.
 */

export const DEVICE_STYLES = ["smart19", "smart25", "smart32", "smart55"] as const;
export type DeviceStyle = (typeof DEVICE_STYLES)[number];

/** Materiais default do 19". Placeholder — trocar por arte de marca. */
export const SMART19_DEFAULT_MATERIALS = [
  { url: "/assets/kuma/smart19-default-top-1920x1080.jpg", w: 1920, h: 1080, slot: "top" },
  { url: "/assets/kuma/smart19-default-bottom-768x1366.jpg", w: 768, h: 1366, slot: "bottom" },
] as const;

export type StyleSource =
  | { kind: "generated"; w: number; h: number; note: string }
  | { kind: "default"; note: string };

/**
 * De onde sai o material de cada style.
 *
 * A ordem dos materiais do 19" importa: índice 0 é a tela de cima.
 */
export const STYLE_SOURCE: Record<DeviceStyle, StyleSource> = {
  smart19: {
    kind: "default",
    note: "Split 1920×1080 + 768×1366 — material default, sem arte própria.",
  },
  smart25: {
    kind: "generated",
    w: 1080,
    h: 2560,
    note: "Full screen, arte própria.",
  },
  smart32: {
    kind: "generated",
    w: 1080,
    h: 1920,
    note: "Full screen, arte própria.",
  },
  smart55: {
    kind: "generated",
    w: 1080,
    h: 1920,
    note: "Mesma resolução do 32\" — reaproveita a mesma arte.",
  },
};
