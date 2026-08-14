/** Formatos de saída — os mesmos dois do gerador de notícias. */
export type WeatherFormat = {
  w: number;
  h: number;
  label: string;
  chip: "chip-a" | "chip-b";
};

export const WEATHER_FORMATS: WeatherFormat[] = [
  { w: 1080, h: 1920, label: '32"', chip: "chip-a" },
  { w: 1080, h: 2560, label: '25"', chip: "chip-b" },
];

/** Escala do preview: 324px de largura para uma arte de 1080px. */
export const PREVIEW_SCALE = 324 / 1080;

export const SPONSOR_LOGO = "/assets/weather/sponsor-logo.png";

export type WeatherAppearance = {
  bg1: string;
  bg2: string;
  divCol: string;
  todayCol: string;
  rainSpeed: number;
};

export const WEEK_APPEARANCE: WeatherAppearance = {
  bg1: "#060b14",
  bg2: "#0d1e35",
  divCol: "#ffffff",
  todayCol: "#1a3a5a",
  rainSpeed: 0.3,
};

/** O modo Dia entra com um azul mais claro, como no gerador original. */
export const DAY_BG1 = "#103a8e";

export type WeekDay = {
  weekday: string;
  date: string;
  max: number | string;
  min: number | string;
  humidity: number | string;
  rain_prob: number | string;
  wind: string;
  condition: string;
  condKey: string;
  isToday?: boolean;
};

export type DaySlot = {
  hour: string;
  temp: number | string;
  rain_prob: number | string;
  wind: string;
  condKey: string;
};

export type WeatherScene =
  | {
      mode: "week";
      city: string;
      days: WeekDay[];
      selectedDate: Date;
      appearance: WeatherAppearance;
    }
  | {
      mode: "day";
      city: string;
      slots: DaySlot[];
      selectedDate: Date;
      appearance: WeatherAppearance;
    };

export const DURATION_OPTIONS = [10, 15, 20, 30] as const;

/** Formata a data no fuso local, sem o desvio de toISOString(). */
export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Converte "YYYY-MM-DD" para um Date local, sem passar por UTC. */
export function fromLocalISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
