import { mapCond } from "./conditions";
import { toLocalISODate, type DaySlot, type WeekDay } from "./spec";

export type Unit = "C" | "F";

const DIAS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** Horários exibidos no modo Dia: de 2 em 2, das 08h às 22h. */
export const TARGET_HOURS = [8, 10, 12, 14, 16, 18, 20, 22];

/**
 * Primeira data cujo card do dia sai inteiro com a previsão que a HG tem agora.
 *
 * A `hourly_forecast` é uma janela móvel de 24 horas a partir da hora corrente,
 * e o card precisa dos oito horários de 08h a 22h. Isso significa que existe uma
 * faixa do dia em que **nenhuma** data é possível: medido às 16h24, a janela ia
 * das 17h de hoje às 16h de amanhã, cobrindo 4 dos 8 alvos de hoje e 6 dos 8 de
 * amanhã. Na prática o card só fecha quando são mais de ~20h (aí amanhã fecha)
 * ou menos de ~10h (aí hoje ainda fecha).
 *
 * Devolve `null` quando não há data possível — quem chama avisa em vez de gerar
 * arte com "—" no lugar da temperatura, que é o que ninguém percebe até estar
 * na tela do condomínio.
 */
export function primeiraDataPossivel(payload: DayPayload): string | null {
  const hoje = new Date();
  for (const offset of [0, 1]) {
    const d = new Date(hoje);
    d.setDate(d.getDate() + offset);
    const iso = toLocalISODate(d);
    if (buildDaySlots(payload, iso).every((s) => s.temp !== "—")) return iso;
  }
  return null;
}

/**
 * Quando o card do dia volta a ser possível, em texto para quem opera.
 *
 * Não é conta exata — depende de a HG publicar as horas — mas dá a ordem certa
 * de grandeza em vez de um "não deu" sem saída.
 */
export function quandoVoltaAFuncionar(agora = new Date()): string {
  const h = agora.getHours();
  if (h >= 10 && h < 20) return "a partir das 20h, para o card de amanhã";
  return "agora — se falhou, a HG está sem as horas publicadas";
}

type HgResults = Record<string, unknown> & { city?: string };

async function fetchHg(woeid: string, hourly: boolean): Promise<HgResults> {
  const url = `/api/weather?woeid=${encodeURIComponent(woeid)}${hourly ? "&hourly=true" : ""}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = await r.json();
  if (data?.error === true) throw new Error(data.message || "Erro na API");
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  if (!data?.results) throw new Error("Sem campo results na resposta");
  return data.results as HgResults;
}

function converter(unit: Unit) {
  return (c: unknown): number | string => {
    if (c === null || c === undefined) return "—";
    const n = Number(c);
    if (Number.isNaN(n)) return "—";
    return unit === "F" ? Math.round((n * 9) / 5 + 32) : n;
  };
}

/* ══════════════════════════════════════════════════════════════
   Semana
   ══════════════════════════════════════════════════════════════ */
export type WeekPayload = { city: string; days: WeekDay[] };

export async function fetchWeek(woeid: string, unit: Unit): Promise<WeekPayload> {
  const res = await fetchHg(woeid, false);
  const toUnit = converter(unit);

  const forecast = (res.forecast as Record<string, unknown>[] | undefined) ?? [];
  const days: WeekDay[] = forecast.map((fc, i) => {
    const wd =
      typeof fc.weekday === "number"
        ? DIAS_PT[fc.weekday]
        : String(fc.weekday ?? "").replace(".", "").slice(0, 3);
    const rainRaw = fc.rain_probability ?? fc.rain_chance ?? fc.rain ?? null;
    return {
      weekday: wd || `D${i + 1}`,
      date: String(fc.date ?? ""), // formato DD/MM/YYYY
      max: toUnit(fc.max),
      min: toUnit(fc.min),
      humidity: fc.humidity != null ? (fc.humidity as number) : "—",
      rain_prob: rainRaw != null ? (rainRaw as number) : "—",
      wind: String(fc.wind_speedy ?? res.wind_speedy ?? "—"),
      condition: String(fc.condition ?? ""),
      condKey: mapCond(String(fc.condition ?? ""), true), // semana sempre usa ícones diurnos
    };
  });

  return { city: String(res.city ?? "Cidade"), days };
}

export type WeekSlice = {
  days: WeekDay[];
  /** false quando a data pedida não existe no forecast e caímos no fallback. */
  matched: boolean;
  /** Data efetivamente usada como primeiro dia, no formato do feed (DD/MM/YYYY). */
  startDate: string;
};

/**
 * Recorta 7 dias a partir da data selecionada.
 *
 * O forecast da HG usa DD/MM/YYYY, então a busca compara só dia e mês.
 * Sem correspondência, começa no dia seguinte a hoje (índice 1) — e devolve
 * `matched: false` para a interface poder avisar, em vez de entregar
 * silenciosamente uma semana diferente da pedida.
 */
export function sliceWeekFromDate(all: WeekDay[], selected: Date): WeekSlice {
  const selDD = String(selected.getDate()).padStart(2, "0");
  const selMM = String(selected.getMonth() + 1).padStart(2, "0");
  const selStr = `${selDD}/${selMM}`;

  const found = all.findIndex((fc) => fc.date.startsWith(selStr));
  const startIdx = found < 0 ? 1 : found;

  const days = all.slice(startIdx, startIdx + 7).map((fc, i) => ({
    ...fc,
    isToday: i === 0, // destaca o primeiro da lista (= dia selecionado)
  }));

  return { days, matched: found >= 0, startDate: days[0]?.date ?? "" };
}

/* ══════════════════════════════════════════════════════════════
   Dia
   ══════════════════════════════════════════════════════════════ */
type RawSlot = {
  hourNum: number;
  hourLabel: string;
  date: string;
  temp: number | string;
  rain_prob: number | string;
  wind: string;
  condKey: string;
};

export type DayPayload = {
  city: string;
  allSlots: RawSlot[];
  currentSlot: RawSlot;
  nowHour: number;
  nowDate: string;
};

export async function fetchDay(woeid: string, unit: Unit): Promise<DayPayload> {
  const res = await fetchHg(woeid, true);
  const toUnit = converter(unit);

  const hourly = (res.hourly_forecast as Record<string, unknown>[] | undefined) ?? [];

  // Formato confirmado da HG: date="2026-05-28", time="09:00"
  const allSlots: RawSlot[] = hourly.map((f) => {
    const fh = parseInt(String(f.time ?? "00:00").split(":")[0], 10);
    const isD = fh >= 6 && fh < 18;
    return {
      hourNum: fh,
      hourLabel: f.time ? String(f.time).slice(0, 5) : `${String(fh).padStart(2, "0")}:00`,
      date: String(f.date ?? ""),
      temp: toUnit(f.temp ?? null),
      rain_prob: (f.rain_probability ?? f.rain ?? "—") as number | string,
      wind: String(f.wind_speedy ?? res.wind_speedy ?? "—"),
      condKey: mapCond(String(f.condition ?? ""), isD),
    };
  });

  // Slot atual do results — cobre a hora corrente quando ela ainda não
  // apareceu no forecast horário.
  const now = new Date();
  const nowH = now.getHours();
  const nowDate = toLocalISODate(now);
  const currentSlot: RawSlot = {
    hourNum: nowH,
    hourLabel: `${String(nowH).padStart(2, "0")}:00`,
    date: nowDate,
    temp: toUnit(res.temp ?? null),
    rain_prob: (res.rain_probability ?? res.rain ?? "—") as number | string,
    wind: String(res.wind_speedy ?? "—"),
    condKey: mapCond(String(res.condition_slug ?? ""), nowH >= 6 && nowH < 18),
  };

  return {
    city: String(res.city ?? "Previsão do Dia"),
    allSlots,
    currentSlot,
    nowHour: nowH,
    nowDate,
  };
}

/**
 * Monta os 8 horários fixos para a data escolhida.
 *
 * Para cada alvo tenta, em ordem: a hora exata do forecast, o slot atual
 * (quando é a hora corrente do dia de hoje) e a hora mais próxima dentro
 * de 2 horas no mesmo dia.
 */
export function buildDaySlots(payload: DayPayload, dateStr: string | null): DaySlot[] {
  const { allSlots, currentSlot, nowHour, nowDate } = payload;
  const daySlots = dateStr ? allSlots.filter((s) => s.date === dateStr) : allSlots;

  return TARGET_HOURS.map((h) => {
    const isD = h >= 6 && h < 18;

    let match = daySlots.find((s) => s.hourNum === h) ?? null;

    if (!match && h === nowHour && (!dateStr || dateStr === nowDate)) {
      match = currentSlot;
    }

    if (!match) {
      match =
        daySlots
          .filter((s) => Math.abs(s.hourNum - h) <= 2)
          .sort((a, b) => Math.abs(a.hourNum - h) - Math.abs(b.hourNum - h))[0] ?? null;
    }

    return {
      hour: match ? match.hourLabel : `${String(h).padStart(2, "0")}:00`,
      temp: match ? match.temp : "—",
      rain_prob: match ? match.rain_prob : "—",
      wind: match ? match.wind : "—",
      condKey: match ? match.condKey : isD ? "clear" : "clear_night",
    };
  });
}
