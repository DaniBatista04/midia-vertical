"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppShell, type ShellStatus } from "@/components/AppShell";
import { useToast } from "@/components/useToast";
import { kumaFilename } from "@/lib/kuma/filename";
import { drawFrame, loadLogo } from "@/lib/weather/draw";
import {
  encodeScene,
  pickCodec,
  transcodeToHevc,
  type CodecChoice,
} from "@/lib/weather/encode";
import {
  buildDaySlots,
  fetchDay,
  fetchWeek,
  primeiraDataPossivel,
  quandoVoltaAFuncionar,
  sliceWeekFromDate,
  type DayPayload,
  type Unit,
} from "@/lib/weather/hg";
import {
  DAY_BG1,
  DURATION_OPTIONS,
  PREVIEW_SCALE,
  WEATHER_FORMATS,
  WEEK_APPEARANCE,
  fromLocalISODate,
  toLocalISODate,
  type WeatherAppearance,
  type WeatherScene,
  type WeekDay,
} from "@/lib/weather/spec";

type Mode = "week" | "day";

export function WeatherGenerator() {
  const { toast, toastNode } = useToast(3000);

  const [mode, setMode] = useState<Mode>("week");
  const [headerText, setHeaderText] = useState("PREVISÃO DO TEMPO");
  const [woeid, setWoeid] = useState("455827");
  // Padrão do campo: amanhã. O componente só renderiza no cliente
  // (ver WeatherGeneratorClient), então não há divergência de fuso.
  const [dateStr, setDateStr] = useState(() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return toLocalISODate(t);
  });
  const [dateBounds, setDateBounds] = useState<{ min?: string; max?: string }>({});
  const [dateEnabled, setDateEnabled] = useState(false);
  const [unit, setUnit] = useState<Unit>("C");
  const [appearance, setAppearance] = useState<WeatherAppearance>({ ...WEEK_APPEARANCE });
  const [duration, setDuration] = useState<number>(10);

  const [weekAll, setWeekAll] = useState<WeekDay[] | null>(null);
  const [dayPayload, setDayPayload] = useState<DayPayload | null>(null);
  const [cityBadge, setCityBadge] = useState<string | null>(null);
  const [fetching, setFetching] = useState<Mode | null>(null);

  const [codec, setCodec] = useState<CodecChoice | null>(null);
  const [encoderState, setEncoderState] = useState<"loading" | "ready" | "error">("loading");
  const [encoderMsg, setEncoderMsg] = useState("Verificando encoder…");

  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [recLabel, setRecLabel] = useState("");
  const cancelRef = useRef(false);

  const [status, setStatus] = useState<ShellStatus>({ text: "Pronto" });

  const [publicando, setPublicando] = useState(false);

  /**
   * Data que o disparo manual vai gerar, ou null quando nenhuma é possível.
   *
   * Sai da previsão que a tela já buscou, então a decisão é tomada com o dado
   * real em vez de uma regra de horário que erraria — a janela de 24h da HG faz
   * existir uma faixa do dia em que nem hoje nem amanhã fecham os oito
   * horários do card.
   */
  const dataPublicavel = useMemo(
    () => (dayPayload ? primeiraDataPossivel(dayPayload) : null),
    [dayPayload],
  );

  /**
   * Aciona o mesmo workflow que roda às 23h, com a data escolhida.
   *
   * O trabalho pesado não acontece aqui: render, ffmpeg e a folga de propagação
   * ficam no runner, que é onde já estão provados. Daqui sai só o pedido.
   */
  const publicarNoKuma = useCallback(async () => {
    if (!dataPublicavel) {
      return toast(`Sem data possível agora — ${quandoVoltaAFuncionar()}.`, "err");
    }
    setPublicando(true);
    try {
      const r = await fetch("/api/clima/publicar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: dataPublicavel, duracao: duration, modo: "dia" }),
      });
      const corpo = (await r.json()) as { error?: string; acompanhar?: string };
      if (!r.ok) throw new Error(corpo.error ?? `HTTP ${r.status}`);
      toast(`✓ Disparado para ${dataPublicavel.split("-").reverse().join("/")}`, "ok");
      setStatus({
        text: `Clima de ${dataPublicavel} em geração — leva ~20 min até aparecer na Análise Criativa`,
      });
    } catch (e) {
      toast(`Erro: ${e instanceof Error ? e.message : e}`, "err");
    } finally {
      setPublicando(false);
    }
  }, [dataPublicavel, duration, toast]);

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null]);
  const rafRef = useRef<number | null>(null);
  const tStartRef = useRef<number | null>(null);

  const setAp = <K extends keyof WeatherAppearance>(k: K, v: WeatherAppearance[K]) =>
    setAppearance((a) => ({ ...a, [k]: v }));

  /* ── Logo do rodapé ──────────────────────────────────────── */
  useEffect(() => {
    loadLogo().catch(() => console.warn("logo do oferecimento não carregou"));
  }, []);

  /* ── Encoder ─────────────────────────────────────────────── */
  // O estado nasce em "loading" e só é reescrito quando a detecção
  // termina, num callback — nunca de forma síncrona dentro do efeito.
  const onCodecFound = useCallback((chosen: CodecChoice) => {
    setCodec(chosen);
    setEncoderState("ready");
    setEncoderMsg(
      chosen.muxerCodec === "hevc"
        ? `✓ Encoder nativo — ${chosen.label}`
        : `${chosen.label} + conversão no servidor`,
    );
    setStatus({ text: "Encoder pronto", ok: true });
  }, []);

  /** O spec de criativo do Kuma pede H.265; H.264 é só rede de segurança. */
  const codecOutOfSpec = codec?.muxerCodec === "avc";

  const onCodecFailed = useCallback(
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setCodec(null);
      setEncoderState("error");
      setEncoderMsg(`Erro: ${msg}`);
      toast(`Encoder: ${msg}`, "err");
    },
    [toast],
  );

  useEffect(() => {
    let alive = true;
    pickCodec()
      .then((chosen) => alive && onCodecFound(chosen))
      .catch((e) => alive && onCodecFailed(e));
    return () => {
      alive = false;
    };
  }, [onCodecFound, onCodecFailed]);

  const retryEncoder = () => {
    setEncoderState("loading");
    setEncoderMsg("Verificando encoder…");
    pickCodec().then(onCodecFound).catch(onCodecFailed);
  };

  /* ── Cena atual ──────────────────────────────────────────── */
  const selectedDate = useMemo(() => {
    if (dateStr) return fromLocalISODate(dateStr);
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t;
  }, [dateStr]);

  const weekSlice = useMemo(
    () => (weekAll ? sliceWeekFromDate(weekAll, selectedDate) : null),
    [weekAll, selectedDate],
  );

  const scene: WeatherScene | null = useMemo(() => {
    const city = headerText.trim() || (mode === "week" ? "Cidade" : "Previsão do Dia");
    if (mode === "week") {
      if (!weekSlice?.days.length) return null;
      return { mode: "week", city, days: weekSlice.days, selectedDate, appearance };
    }
    if (!dayPayload) return null;
    const slots = buildDaySlots(dayPayload, dateStr || null);
    if (!slots.length) return null;
    return { mode: "day", city, slots, selectedDate, appearance };
  }, [mode, weekSlice, dayPayload, headerText, selectedDate, dateStr, appearance]);

  /* ── Loop de animação do preview ─────────────────────────── */
  useEffect(() => {
    if (!scene) return;
    tStartRef.current = tStartRef.current ?? performance.now();

    const loop = (now: number) => {
      const t = now - (tStartRef.current ?? now);
      WEATHER_FORMATS.forEach((fmt, i) => {
        const cv = canvasRefs.current[i];
        if (!cv) return;
        try {
          drawFrame(cv, scene, t);
        } catch (e) {
          console.error("[drawFrame error]", e);
        }
      });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scene]);

  /* ── Busca ───────────────────────────────────────────────── */
  const loadWeek = async () => {
    if (!woeid.trim()) return toast("Informe o WOEID.", "err");
    setFetching("week");
    setStatus({ text: "Buscando previsão da semana…" });

    setHeaderText("PREVISÃO DA SEMANA");
    setAp("bg1", WEEK_APPEARANCE.bg1);
    setDateEnabled(true);
    setDateBounds({});

    try {
      const { city, days } = await fetchWeek(woeid.trim(), unit);
      setWeekAll(days);
      setMode("week");
      tStartRef.current = null;
      setCityBadge(city);
      const slice = sliceWeekFromDate(days, selectedDate);
      setStatus({ text: "Previsão carregada", ok: true });
      toast(`✓ ${city} — ${slice.days.length} dias`, "ok");
    } catch (e) {
      toast(`Erro: ${e instanceof Error ? e.message : e}`, "err");
      setStatus({ text: "Erro", err: true });
      console.error(e);
    } finally {
      setFetching(null);
    }
  };

  const loadDay = async () => {
    if (!woeid.trim()) return toast("Informe o WOEID.", "err");
    setFetching("day");
    setStatus({ text: "Buscando previsão do dia…" });

    setHeaderText("PREVISÃO DO DIA");
    setAp("bg1", DAY_BG1);

    // Modo Dia só faz sentido para hoje ou amanhã.
    const today = new Date();
    const tmrw = new Date();
    tmrw.setDate(tmrw.getDate() + 1);
    setDateStr(toLocalISODate(today));
    setDateEnabled(true);
    setDateBounds({ min: toLocalISODate(today), max: toLocalISODate(tmrw) });

    try {
      const payload = await fetchDay(woeid.trim(), unit);
      setDayPayload(payload);
      setMode("day");
      tStartRef.current = null;
      setCityBadge(payload.city);
      const slots = buildDaySlots(payload, toLocalISODate(today));
      setStatus({ text: "Previsão do dia carregada", ok: true });
      toast(`✓ ${payload.city} — ${slots.length} horários`, "ok");
    } catch (e) {
      toast(`Erro: ${e instanceof Error ? e.message : e}`, "err");
      setStatus({ text: "Erro", err: true });
      console.error(e);
    } finally {
      setFetching(null);
    }
  };

  /* ── Exportação ──────────────────────────────────────────── */
  const buildFilename = (fmtIndex: number) => {
    const d = selectedDate;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const fmt = WEATHER_FORMATS[fmtIndex];
    const b = mode === "week" ? "1" : "2";
    return kumaFilename(`weather-${yyyy}${mm}${dd}-${b}-${duration}s`, fmt.w, fmt.h, "mp4");
  };

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const runExport = async (indices: number[]) => {
    if (!scene) return toast("Busque a previsão primeiro.", "err");
    if (!codec) return toast("Encoder não disponível.", "err");

    cancelRef.current = false;
    setRecording(true);
    setProgress(0);

    try {
      for (let k = 0; k < indices.length; k++) {
        if (cancelRef.current) break;
        const i = indices[k];
        const fmt = WEATHER_FORMATS[i];
        const phase = indices.length > 1 ? `${k + 1}/${indices.length}` : "Exportando";
        setRecLabel(`Codificando ${fmt.w}×${fmt.h}…`);

        const encoded = await encodeScene({
          scene,
          fmt,
          durationSeconds: duration,
          codec,
          onProgress: (pct, frame, total) => {
            setProgress(pct);
            setProgressLabel(`${phase} — frame ${frame}/${total}`);
          },
          shouldCancel: () => cancelRef.current,
        });
        if (!encoded) break;

        // Sem encoder HEVC na máquina, o servidor converte antes de salvar —
        // o operador nunca fica com um arquivo fora do spec na mão.
        let mp4 = encoded;
        let converted = false;
        if (codecOutOfSpec) {
          setProgress(100);
          setRecLabel(`Convertendo ${fmt.w}×${fmt.h} para H.265…`);
          setProgressLabel(`${phase} — convertendo para H.265`);
          try {
            mp4 = await transcodeToHevc(encoded);
            converted = true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            toast(`Conversão falhou (${msg}) — salvando em H.264.`, "err");
            console.error("[transcode]", e);
          }
        }

        const sizeMB = (mp4.size / 1024 / 1024).toFixed(1);
        saveBlob(mp4, buildFilename(i));
        setProgress(100);
        setProgressLabel(`✓ ${fmt.w}×${fmt.h} — ${sizeMB} MB`);

        const inSpec = !codecOutOfSpec || converted;
        toast(
          inSpec
            ? `✓ ${fmt.w}×${fmt.h} — ${sizeMB}MB em H.265`
            : `${fmt.w}×${fmt.h} — ${sizeMB}MB em H.264, fora do spec do Kuma`,
          inSpec ? "ok" : "",
        );
      }

      if (cancelRef.current) {
        setStatus({ text: "Cancelado" });
      } else {
        setStatus({ text: indices.length > 1 ? "Ambos exportados" : "MP4 exportado", ok: true });
      }
    } catch (e) {
      toast(`Erro: ${e instanceof Error ? e.message : e}`, "err");
      setStatus({ text: "Erro", err: true });
      console.error(e);
    } finally {
      setRecording(false);
      setRecLabel("");
    }
  };

  const canRecord = Boolean(scene) && encoderState === "ready" && !recording;

  /* ── Sidebar ─────────────────────────────────────────────── */
  const aside = (
    <>
      <div className="slabel">Configuração</div>

      <div className="sidebar-section">
        <div className="field-row">
          <span className="field-label">Texto do cabeçalho</span>
          <input
            type="text"
            value={headerText}
            placeholder="Ex: PREVISÃO DO TEMPO"
            onChange={(e) => setHeaderText(e.target.value)}
          />
        </div>
        <div className="field-row">
          <span className="field-label">WOEID</span>
          <input
            type="text"
            value={woeid}
            placeholder="Ex: 455827"
            inputMode="numeric"
            onChange={(e) => setWoeid(e.target.value)}
          />
        </div>
        <div className="field-row">
          <span className="field-label">Data da imagem</span>
          <input
            type="date"
            value={dateStr}
            min={dateBounds.min}
            max={dateBounds.max}
            disabled={!dateEnabled}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>
        <div className="field-row">
          <span className="field-label">Temperatura</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            <option value="C">Celsius (°C)</option>
            <option value="F">Fahrenheit (°F)</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-accent" style={{ flex: 1 }}
            onClick={loadWeek} disabled={fetching !== null}>
            {fetching === "week" ? <><span className="spinner" /> Buscando…</> : "📅 Semana"}
          </button>
          <button className="btn btn-blue" style={{ flex: 1 }}
            onClick={loadDay} disabled={fetching !== null}>
            {fetching === "day" ? <><span className="spinner" /> Buscando…</> : "🕐 Dia"}
          </button>
        </div>
        {cityBadge && <div className="city-badge">📍 {cityBadge}</div>}

        {mode === "week" && weekSlice && !weekSlice.matched && (
          <div className="notice-warn">
            A data escolhida não está no forecast da HG. A arte começa em{" "}
            <strong>{weekSlice.startDate || "—"}</strong>.
          </div>
        )}
      </div>

      <div className="sidebar-section">
        <div className="slabel" style={{ padding: "0 0 8px" }}>Aparência</div>
        <div className="ctrl-row">
          <span className="clabel">Fundo 1</span>
          <Swatch value={appearance.bg1} onChange={(v) => setAp("bg1", v)} />
          <span className="clabel">Fundo 2</span>
          <Swatch value={appearance.bg2} onChange={(v) => setAp("bg2", v)} />
        </div>
        <div className="ctrl-row">
          <span className="clabel">Separador</span>
          <Swatch value={appearance.divCol} onChange={(v) => setAp("divCol", v)} />
          <span className="clabel">Hoje</span>
          <Swatch value={appearance.todayCol} onChange={(v) => setAp("todayCol", v)} />
        </div>
        <div className="ctrl-row">
          <span className="clabel">Vel. chuva</span>
          <input type="range" min={0.1} max={1} step={0.1} value={appearance.rainSpeed}
            onChange={(e) => setAp("rainSpeed", parseFloat(e.target.value))} />
          <span className="rval">{appearance.rainSpeed.toFixed(1)}</span>
          <span className="runit">×</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="slabel" style={{ padding: "0 0 6px" }}>Duração</div>
        <select value={duration} onChange={(e) => setDuration(parseInt(e.target.value, 10))}>
          {DURATION_OPTIONS.map((d) => (
            <option key={d} value={d}>{d} segundos</option>
          ))}
        </select>
      </div>

      <div className="sidebar-section">
        <div className="slabel" style={{ padding: "0 0 6px" }}>Exportar MP4</div>

        <div
          className={`encoder-status ${
            encoderState === "error" ? "" : codecOutOfSpec ? "warn" : encoderState
          }`}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {encoderState === "loading" && <span className="spinner" />}
            <span>{encoderMsg}</span>
          </div>
          {codecOutOfSpec && (
            <span className="encoder-note">
              Esta máquina não tem H.265. A conversão para o padrão do Kuma
              acontece no servidor, automaticamente, ao exportar.
            </span>
          )}
          {encoderState === "error" && (
            <button className="btn btn-ghost btn-sm" onClick={retryEncoder}>
              ↻ Tentar novamente
            </button>
          )}
        </div>

        {recording && (
          <>
            <div className="rec-status">
              <div className="rec-dot" />
              <span>{recLabel || "Aguarde…"}</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
        <div className="progress-label">{progressLabel}</div>

        <button className="btn btn-accent" disabled={!canRecord}
          onClick={() => void runExport([0, 1])}>
          ⏺ Exportar os dois
        </button>
        <button className="btn btn-blue" disabled={!canRecord}
          onClick={() => void runExport([0])}>
          ⏺ Exportar 32&quot; (1080×1920)
        </button>
        <button className="btn btn-blue" disabled={!canRecord}
          onClick={() => void runExport([1])}>
          ⏺ Exportar 25&quot; (1080×2560)
        </button>
        <button className="btn btn-ghost btn-sm" disabled={!recording}
          onClick={() => { cancelRef.current = true; }}>
          ⏹ Cancelar
        </button>

        <div className="publicar-bloco">
          <button className="btn btn-accent" disabled={publicando || !dayPayload}
            onClick={() => void publicarNoKuma()}>
            {publicando
              ? <><span className="spinner" /> Disparando…</>
              : "🚀 Enviar para o Kuma"}
          </button>
          <span className="publicar-nota">
            {!dayPayload
              ? "Busque a previsão do Dia para liberar o envio."
              : dataPublicavel
                ? `Gera e submete o clima de ${dataPublicavel.split("-").reverse().join("/")}. `
                  + "A unidade é criada sozinha assim que você aprovar no portal."
                : "Sem data possível agora — a previsão horária da HG não cobre nenhum dia "
                  + `inteiro. Volta a funcionar ${quandoVoltaAFuncionar()}.`}
          </span>
        </div>
      </div>
    </>
  );

  return (
    <AppShell
      app="weather"
      logo={<>WEATHER<span>WEEK</span></>}
      tag={<div className="tag tag-purple">{mode === "week" ? "7 DIAS" : "POR HORA"}</div>}
      status={status}
      aside={aside}
      asideScroll
    >
      <div className="canvas-area">
        {WEATHER_FORMATS.map((fmt, i) => (
          <div className="canvas-col" key={fmt.label}>
            <div className="col-header">
              <span className={`format-chip ${fmt.chip}`}>{fmt.w} × {fmt.h}</span>
              <span className="col-title">Tela {fmt.label}</span>
            </div>
            <div className="canvas-wrap">
              <canvas
                ref={(el) => { canvasRefs.current[i] = el; }}
                width={Math.round(fmt.w * PREVIEW_SCALE)}
                height={Math.round(fmt.h * PREVIEW_SCALE)}
              />
              {!scene && (
                <div className="empty-overlay">
                  <div className="ei">📅</div>
                  <p style={{ fontSize: 11 }}>Busque a previsão para preview</p>
                </div>
              )}
            </div>
            <div className="canvas-dim">{fmt.w} × {fmt.h} px</div>
          </div>
        ))}
      </div>

      {toastNode}
    </AppShell>
  );
}

function Swatch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="cswatch">
      <div className="cswatch-prev" style={{ background: value }} />
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
