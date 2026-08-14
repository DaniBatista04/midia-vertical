export type Condition = { emoji: string; color: string; label: string };

export const COND_MAP: Record<string, Condition> = {
  storm: { emoji: "⛈", color: "#8080ff", label: "Tempestade" },
  storm_night: { emoji: "⛈", color: "#6060cc", label: "Tempestade" },
  snow: { emoji: "❄", color: "#aaddff", label: "Neve" },
  hail: { emoji: "🌨", color: "#99ccee", label: "Granizo" },
  rain: { emoji: "🌧", color: "#6ab0ff", label: "Chuva" },
  rain_night: { emoji: "🌧", color: "#4a88cc", label: "Chuva" },
  fog: { emoji: "🌫", color: "#aabbcc", label: "Névoa" },
  fog_night: { emoji: "🌫", color: "#7788aa", label: "Névoa" },
  drizzle: { emoji: "🌦", color: "#88bbdd", label: "Garoa" },
  drizzle_night: { emoji: "🌧", color: "#5588aa", label: "Garoa" },
  cloud: { emoji: "☁", color: "#99aabb", label: "Nublado" },
  cloud_night: { emoji: "☁", color: "#6677aa", label: "Nublado" },
  partly_cloudy: { emoji: "⛅", color: "#ffcc66", label: "Parcial" },
  partly_cloudy_night: { emoji: "🌙", color: "#99aaff", label: "Parcial" },
  clear_night: { emoji: "🌙", color: "#99aaff", label: "Noite" },
  clear: { emoji: "☀", color: "#ffe566", label: "Sol" },
};

/** Normaliza o slug da HG Brasil na chave usada pelos ícones. */
export function mapCond(slug: string, isDay = true): string {
  const s = (slug || "").toLowerCase();
  if (s.includes("storm") || s.includes("thunder")) return isDay ? "storm" : "storm_night";
  if (s.includes("snow")) return "snow";
  if (s.includes("hail")) return "hail";
  if (s.includes("rain") || s.includes("shower")) return isDay ? "rain" : "rain_night";
  if (s.includes("fog") || s.includes("mist")) return isDay ? "fog" : "fog_night";
  if (s.includes("drizzle")) return isDay ? "drizzle" : "drizzle_night";
  if (s.includes("overcast") || s === "cloudy") return isDay ? "cloud" : "cloud_night";
  if (s.includes("cloud") || s.includes("partly")) {
    return isDay ? "partly_cloudy" : "partly_cloudy_night";
  }
  if (!isDay) return "clear_night";
  return "clear";
}
