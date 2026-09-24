"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { DiaNoticias, EnvioDoDia } from "@/app/api/noticias/dia/route";
import { proxiedImage } from "@/lib/news/draw";
import type { NewsItem } from "@/lib/news/spec";
import {
  caixaDaHora as caixaPedida,
  campoParaHora,
  emMinutos,
  FIM_DIA,
  horaParaCampo,
  noMinuto,
  rotuloHora,
} from "@/lib/kuma/noticiaCaixas";
import type { Salvamento } from "@/components/news/NewsGenerator";

/**
 * A programação do dia: a linha do tempo com as janelas e, embaixo, uma caixa
 * por janela com as suas vagas.
 *
 * Mostra junto o que já foi enviado (vem do servidor, em `dia`) e o que está
 * marcado na fila e ainda não foi (`alocacao`, local). Só o que não foi enviado
 * se arrasta: o envio já tem grupo criativo com a caixa gravada.
 */

export const CORES_CAIXA = [
  "#5ce3ff", "#b18cff", "#ffb347", "#7dff9a", "#ff7ab6", "#ffe066",
  "#6f9bff", "#ff8f6b", "#4de0c0", "#d78cff", "#c6f06b", "#ffa8d0",
];

type Props = {
  items: NewsItem[];
  /** Índice do feed → caixa, para o que está na fila e não foi enviado. */
  alocacao: Map<number, number>;
  caixas: number;
  maxCaixas: number;
  cortes: number[];
  /** Hora em que o pack 1 entra; antes dela fica o último. */
  inicio: number;
  dia: DiaNoticias | null;
  carregando: boolean;
  /** Quando o dia foi lido por último (ms), para o "atualizado há". */
  lidoEm: number | null;
  /** A última leitura do dia falhou. */
  falhaLeitura: boolean;
  /** Envio em andamento: o painel mostra o progresso e a notícia que está subindo. */
  enviando: { feitas: number; total: number; item: number } | null;
  busy: boolean;
  selIdx: number | null;
  /** Vagas de cada pack, na ordem (o tamanho escolhido, ou o teto). */
  vagasPorPack: number[];
  /** O máximo de vagas que um pack pode ter com a frequência da unidade. */
  vagasMax: number;
  /** Como está a gravação sozinha da grade. */
  salvamento: Salvamento;
  onTentarSalvar: () => void;
  /** As abas de dia: hoje e os próximos, para agendar. */
  dias: { data: string; rotulo: string }[];
  dataSel: string;
  onData: (data: string) => void;
  onVagas: (caixa: number, vagas: number) => void;
  onMover: (item: number, caixa: number, trocarCom?: number) => void;
  onRemover: (item: number) => void;
  /** Tira do pack uma notícia já enviada. */
  onRetirar: (id: string, titulo: string) => void;
  onSelecionar: (item: number) => void;
  onCortes: (cortes: number[]) => void;
  onInicio: (inicio: number) => void;
  onNovaCaixa: () => void;
  onDuasHoras: () => void;
  onRemoverCaixa: (caixa: number) => void;
  onEnviar: () => void;
  onAtualizar: () => void;
};

/** `rotulo` cabe no selo do card; `detalhe` vai na linha de baixo (minutos, horário). */
type Selo = { rotulo: string; detalhe?: string; classe: string; dica: string; passo: number };

/**
 * O selo de uma notícia enviada: em que etapa está, em palavras de quem opera,
 * e o que falta. `passo` alimenta a barrinha de três etapas do card — subir,
 * aprovar, ir ao ar.
 */
function seloDoEnvio(
  e: EnvioDoDia,
  estadoPack: "live" | "passou" | "vem",
  entraAs: number,
  agora: number,
): Selo {
  switch (e.etapa) {
    case "propagando": {
      const faltam = e.submeteEm ? Math.ceil((Date.parse(e.submeteEm) - agora) / 60_000) : null;
      return {
        rotulo: "Subindo",
        detalhe: faltam && faltam > 0 ? `análise em ${faltam} min` : "indo para a análise",
        classe: "sub",
        dica:
          "O material está propagando no Storage. O grupo criativo vai para a Análise Criativa " +
          (faltam && faltam > 0 ? `em cerca de ${faltam} min.` : "no próximo minuto."),
        passo: 1,
      };
    }
    case "em-aprovacao":
      return {
        rotulo: "Aprovar",
        detalhe: "no portal do Kuma",
        classe: "apr",
        dica: "Está na Análise Criativa do portal do Kuma, esperando aprovação.",
        passo: 2,
      };
    case "no-plano":
      if (e.noAr) return { rotulo: "No ar", classe: "noar", dica: "Está na lista que o Kuma toca agora.", passo: 3 };
      if (estadoPack === "vem") {
        return {
          rotulo: "Aprovada",
          detalhe: `entra às ${rotuloHora(entraAs)}`,
          classe: "ok",
          dica: `Aprovada. Entra no ar com o pack, às ${rotuloHora(entraAs)}.`,
          passo: 3,
        };
      }
      if (estadoPack === "live") {
        return {
          rotulo: "Aprovada",
          detalhe: "entrando no ar…",
          classe: "ok",
          dica: "Aprovada. O sistema coloca ela na lista do Kuma no próximo minuto.",
          passo: 3,
        };
      }
      return {
        rotulo: "Aprovada",
        detalhe: "janela encerrada",
        classe: "ok",
        dica: "Aprovada. A janela do pack já passou.",
        passo: 3,
      };
    default:
      return { rotulo: "Parada", classe: "err", dica: e.erro ?? "", passo: 0 };
  }
}

/** `42` → "há 42 s"; `130` → "há 2 min". */
function ha(segundos: number): string {
  if (segundos < 60) return `há ${Math.max(0, Math.round(segundos))} s`;
  return `há ${Math.floor(segundos / 60)} min`;
}

/*
 * A linha do tempo mostra o dia inteiro, e não só a partir do início: o que vem
 * antes do pack 1 é do último, e o operador precisa ver isso para escolher o
 * início.
 */
const HORAS = FIM_DIA;
const pct = (h: number) => `${(Math.min(Math.max(h, 0), FIM_DIA) / HORAS) * 100}%`;

export function NewsBoxes(p: Props) {
  const [aberto, setAberto] = useState(true);
  const [alvo, setAlvo] = useState<number | null>(null);
  /** O divisor com o horário aberto para digitar: `-1` é o início do pack 1. */
  const [editando, setEditando] = useState<number | null>(null);
  /** Esc fecha o campo sem gravar — e o `blur` da saída não pode gravar. */
  const descartar = useRef(false);
  const trilho = useRef<HTMLDivElement>(null);
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const enviados = (p.dia?.envios ?? []).filter((e) => e.etapa !== "parado" && e.etapa !== "retirada");
  const retiradas = (p.dia?.envios ?? []).filter((e) => e.etapa === "retirada");
  const parados = (p.dia?.envios ?? []).filter((e) => e.etapa === "parado");
  const subindo = enviados.filter((e) => e.etapa === "propagando").length;
  const aprovar = enviados.filter((e) => e.etapa === "em-aprovacao").length;
  const aprovadas = enviados.filter((e) => e.etapa === "no-plano").length;
  const pendentes = [...p.alocacao.entries()];
  // Só hoje há "agora": num dia agendado nada está no ar nem encerrado ainda.
  const hora = p.dia?.hoje ? p.dia.hora : null;
  const caixaDaHora = hora === null ? null : caixaPedida(p.cortes, hora, p.inicio);
  /** Madrugada: o último pack segue no ar, e os outros ainda estão por vir. */
  const antesDoInicio = hora !== null && hora < p.inicio && p.caixas > 1;
  const noAr = p.dia?.caixaNoAr ?? null;
  const volta = p.caixas > 1 && p.inicio > 0;

  const janela = (c: number) => ({
    inicio: c === 1 ? (p.caixas === 1 ? 0 : p.inicio) : p.cortes[c - 2],
    fim: c === p.caixas ? FIM_DIA : p.cortes[c - 1],
  });

  /*
   * Mover um divisor — o início do pack 1 (`i = -1`) ou uma troca — para a
   * hora `h`, levada ao minuto e presa entre os vizinhos, com pelo menos um
   * minuto de janela para cada pack.
   */
  const MINUTO = 1 / 60;
  const moverCorte = (i: number, h: number) => {
    const alvoH = noMinuto(h);
    if (i < 0) {
      const ini = Math.min(Math.max(alvoH, 0), (p.cortes[0] ?? FIM_DIA) - MINUTO);
      if (emMinutos(ini) !== emMinutos(p.inicio)) p.onInicio(noMinuto(ini));
      return;
    }
    const min = (i === 0 ? p.inicio : p.cortes[i - 1]) + MINUTO;
    const max = (i === p.cortes.length - 1 ? FIM_DIA : p.cortes[i + 1]) - MINUTO;
    const corte = noMinuto(Math.min(Math.max(alvoH, min), max));
    if (emMinutos(corte) !== emMinutos(p.cortes[i])) p.onCortes(p.cortes.map((c, k) => (k === i ? corte : c)));
  };
  const horaDoCorte = (i: number) => (i < 0 ? p.inicio : p.cortes[i]);

  /* ── Arrastar um divisor, de minuto em minuto ─────────────── */
  const arrastarCorte = (i: number) => (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const el = trilho.current;
    if (!el) return;
    const alvoEl = ev.currentTarget;
    alvoEl.focus();
    alvoEl.setPointerCapture(ev.pointerId);
    const mover = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      moverCorte(i, ((e.clientX - r.left) / r.width) * HORAS);
    };
    const soltar = () => {
      alvoEl.removeEventListener("pointermove", mover);
      alvoEl.removeEventListener("pointerup", soltar);
      alvoEl.removeEventListener("pointercancel", soltar);
    };
    alvoEl.addEventListener("pointermove", mover);
    alvoEl.addEventListener("pointerup", soltar);
    alvoEl.addEventListener("pointercancel", soltar);
  };

  /* No trilho um pixel vale mais de um minuto: o acerto fino é pelas setas
     (um minuto; com Shift, quinze) ou digitando o horário. */
  const teclaNoCorte = (i: number) => (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      setEditando(i);
      return;
    }
    const passo = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (!passo) return;
    ev.preventDefault();
    moverCorte(i, horaDoCorte(i) + passo * (ev.shiftKey ? 15 : 1) * MINUTO);
  };

  const rotuloDoCorte = (i: number) =>
    editando === i ? (
      <input
        type="time"
        step={60}
        className="tl-cut-campo"
        autoFocus
        defaultValue={horaParaCampo(horaDoCorte(i))}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            descartar.current = true;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const h = campoParaHora(e.currentTarget.value);
          if (h !== null && !descartar.current) moverCorte(i, h);
          descartar.current = false;
          setEditando(null);
        }}
      />
    ) : (
      <span
        className="tl-cut-lbl"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setEditando(i)}
        title="Clique para digitar o horário"
      >
        {rotuloHora(horaDoCorte(i))}
      </span>
    );

  /* ── Drag & drop das notícias pendentes ───────────────────── */
  const aoArrastar = (item: number) => (e: DragEvent) => {
    e.dataTransfer.setData("text/plain", String(item));
    e.dataTransfer.effectAllowed = "move";
  };
  const soltarEm = (caixa: number, trocarCom?: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAlvo(null);
    const item = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isInteger(item)) p.onMover(item, caixa, trocarCom);
  };

  const totalPendentes = pendentes.length;
  const caixasUsadas = new Set(pendentes.map(([, c]) => c)).size;

  return (
    <section className={`boxes-dock${aberto ? "" : " fechado"}`}>
      <header className="boxes-head">
        <button className="boxes-toggle" onClick={() => setAberto((a) => !a)} title={aberto ? "Recolher" : "Abrir"}>
          <span className={`chev${aberto ? " on" : ""}`}>▸</span>
          <span className="boxes-title">Programação do dia</span>
        </button>

        <div className="dias-linha">
        <div className="dias-tabs" role="tablist">
          {p.dias.map((d) => (
            <button
              key={d.data}
              role="tab"
              aria-selected={d.data === p.dataSel}
              className={`dia-tab${d.data === p.dataSel ? " on" : ""}`}
              onClick={() => p.onData(d.data)}
              title={d.data.split("-").reverse().join("/")}
            >
              {d.rotulo}
            </button>
          ))}
        </div>
        </div>

        {!p.dia ? (
          <div className="boxes-resumo">
            <span className={p.falhaLeitura ? "boxes-lido err" : "boxes-lido"}>
              {p.falhaLeitura ? "não deu para ler a programação" : <><span className="spinner mini" /> lendo a programação…</>}
            </span>
          </div>
        ) : (
        <div className="boxes-resumo">
          {subindo > 0 && (
            <span className="etapa-chip sub" title="Material propagando; vai para a Análise Criativa em ~10 min">
              <i /> {subindo} subindo
            </span>
          )}
          {aprovar > 0 && (
            <span className="etapa-chip apr" title="Esperando aprovação na Análise Criativa do portal do Kuma">
              <i /> {aprovar} para aprovar no Kuma
            </span>
          )}
          <span className="etapa-chip ok" title="Aprovadas e no plano do dia">
            <i /> {aprovadas} aprovada{aprovadas === 1 ? "" : "s"}
          </span>
          <span className="sep" />
          <span><b>{totalPendentes}</b> na fila</span>
          <span className="sep" />
          <span><b>{p.caixas}</b> pack{p.caixas === 1 ? "" : "s"}</span>
          {noAr !== null && (
            <span className="boxes-noar" style={{ ["--c" as string]: CORES_CAIXA[noAr - 1] }}>
              <i /> Pack {noAr} no ar
            </span>
          )}
        </div>
        )}

        <div className="boxes-acoes">
          <button className="btn btn-ghost btn-sm" onClick={p.onDuasHoras} disabled={p.busy || !p.dia}
            title="Divide o dia em packs de 2 horas, a partir do início do pack 1">
            De 2 em 2 h
          </button>
          <span className={`boxes-lido${p.falhaLeitura ? " err" : ""}`}>
            {p.falhaLeitura
              ? "falha ao atualizar"
              : p.lidoEm !== null
                ? `atualizado ${ha((agora - p.lidoEm) / 1000)}`
                : ""}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={p.onAtualizar} disabled={p.carregando}
            title="Relê o que já foi enviado hoje">
            {p.carregando ? <span className="spinner" /> : "↻"}
          </button>
          <span className={`grade-salva ${p.salvamento.estado}`}
            title={p.salvamento.erro ?? "Horários e tamanhos dos packs são gravados sozinhos a cada mudança"}>
            {p.salvamento.estado === "salvando" ? (
              <><span className="spinner mini" /> salvando…</>
            ) : p.salvamento.estado === "erro" ? (
              <>⚠ não salvou <button className="link-btn" onClick={p.onTentarSalvar}>tentar de novo</button></>
            ) : p.salvamento.em ? (
              <>✓ grade salva</>
            ) : null}
          </span>
          <button className="btn btn-accent btn-sm boxes-enviar" onClick={p.onEnviar}
            disabled={!totalPendentes || p.busy}>
            {p.enviando ? (
              <><span className="spinner" /> Enviando {p.enviando.feitas + 1} de {p.enviando.total}…</>
            ) : (
              <>
                🚀 Enviar {totalPendentes || ""} {totalPendentes === 1 ? "notícia" : "notícias"}
                {caixasUsadas > 1 ? ` em ${caixasUsadas} packs` : ""}
              </>
            )}
          </button>
        </div>
      </header>

      {p.enviando && (
        <div className="boxes-progresso" title={`${p.enviando.feitas} de ${p.enviando.total} enviadas`}>
          <i style={{ width: `${(p.enviando.feitas / p.enviando.total) * 100}%` }} />
        </div>
      )}

      {aberto && !p.dia && (
        <div className="boxes-body">
          {p.falhaLeitura ? (
            <div className="boxes-falha">
              Não deu para ler a programação do dia.
              <button className="btn btn-ghost btn-sm" onClick={p.onAtualizar} disabled={p.carregando}>
                {p.carregando ? <span className="spinner" /> : "Tentar de novo"}
              </button>
            </div>
          ) : (
            <div className="boxes-skel" aria-label="Lendo a programação do dia">
              <div className="skel skel-trilho" />
              <div className="bx-row">
                {[0, 1].map((k) => (
                  <div key={k} className="bx bx-skel">
                    <div className="skel skel-line" />
                    <div className="bx-slots">
                      {[0, 1, 2, 3].map((s) => <div key={s} className="slot skel" />)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {aberto && p.dia && (
        <div className="boxes-body">
          {/* ── Linha do tempo ───────────────────────────────── */}
          <div className="tl">
            <div className="tl-track" ref={trilho}>
              {Array.from({ length: p.caixas }, (_, k) => {
                const c = k + 1;
                const j = janela(c);
                const live = noAr === c && !(antesDoInicio && c === p.caixas);
                return (
                  <div
                    key={c}
                    className={`tl-seg${live ? " live" : ""}`}
                    style={{
                      left: pct(j.inicio),
                      width: `calc(${pct(j.fim)} - ${pct(j.inicio)})`,
                      ["--c" as string]: CORES_CAIXA[k],
                    }}
                  >
                    <span className="tl-seg-lbl">
                      Pack {c}
                      <em>{rotuloHora(j.inicio)} – {rotuloHora(j.fim)}</em>
                    </span>
                  </div>
                );
              })}

              {volta && (
                <div
                  className={`tl-seg volta${antesDoInicio && noAr === p.caixas ? " live" : ""}`}
                  style={{
                    left: pct(0),
                    width: pct(p.inicio),
                    ["--c" as string]: CORES_CAIXA[p.caixas - 1],
                  }}
                  title={`Antes do pack 1 segue o pack ${p.caixas}, da noite anterior`}
                >
                  <span className="tl-seg-lbl">
                    ↺ {p.caixas}
                    <em>{rotuloHora(0)} – {rotuloHora(p.inicio)}</em>
                  </span>
                </div>
              )}

              {p.caixas > 1 && (
                <div
                  className="tl-cut tl-ini"
                  style={{ left: pct(p.inicio) }}
                  onPointerDown={arrastarCorte(-1)}
                  onKeyDown={teclaNoCorte(-1)}
                  tabIndex={0}
                  role="slider"
                  aria-label="Início do pack 1"
                  aria-valuenow={emMinutos(p.inicio)}
                  aria-valuemin={0}
                  aria-valuemax={emMinutos(FIM_DIA)}
                  aria-valuetext={rotuloHora(p.inicio)}
                  title="Arraste, use as setas (minuto a minuto) ou clique no horário para digitar a hora em que o pack 1 entra"
                >
                  <span className="tl-cut-knob" />
                  {rotuloDoCorte(-1)}
                </div>
              )}

              {p.cortes.map((h, i) => (
                <div
                  key={i}
                  className="tl-cut"
                  style={{ left: pct(h) }}
                  onPointerDown={arrastarCorte(i)}
                  onKeyDown={teclaNoCorte(i)}
                  tabIndex={0}
                  role="slider"
                  aria-label={`Troca para o pack ${i + 2}`}
                  aria-valuenow={emMinutos(h)}
                  aria-valuemin={0}
                  aria-valuemax={emMinutos(FIM_DIA)}
                  aria-valuetext={rotuloHora(h)}
                  title="Arraste, use as setas (minuto a minuto) ou clique no horário para digitar a hora da troca"
                >
                  <span className="tl-cut-knob" />
                  {rotuloDoCorte(i)}
                </div>
              ))}

              {hora !== null && (
                <div className="tl-now" style={{ left: pct(hora) }}>
                  <span className="tl-now-dot" />
                  <span className="tl-now-lbl">
                    agora · {horaParaCampo(hora)}
                  </span>
                </div>
              )}
            </div>
            <div className="tl-ticks">
              {Array.from({ length: HORAS / 2 + 1 }, (_, k) => k * 2).map((h) => (
                <span key={h} style={{ left: pct(h) }}>{rotuloHora(h)}</span>
              ))}
            </div>
          </div>

          {/* ── Caixas ───────────────────────────────────────── */}
          <div className="bx-row">
            {Array.from({ length: p.caixas }, (_, k) => {
              const c = k + 1;
              const j = janela(c);
              const deles = enviados.filter((e) => e.caixa === c);
              const meus = pendentes.filter(([, cx]) => cx === c).map(([i]) => i);
              const ocupadas = deles.length + meus.length;
              const vagas = p.vagasPorPack[k] ?? p.vagasMax;
              const livres = Math.max(0, vagas - ocupadas);
              const cheia = livres === 0;
              // Quantos lugares a estratégia terá: o menor divisor do teto que
              // comporta as notícias (a regra da Brato), e daí a fatia de cada uma.
              const lugares = ocupadas
                ? Array.from({ length: p.vagasMax }, (_, n) => n + 1).find((n) => n >= ocupadas && p.vagasMax % n === 0) ?? p.vagasMax
                : 0;
              const repete = lugares > ocupadas;
              const fatia = lugares ? Math.round((p.dia?.frequencia ?? 240) / lugares) : 0;
              const estado =
                noAr === c
                  ? "live"
                  : !antesDoInicio && caixaDaHora !== null && c < caixaDaHora
                    ? "passou"
                    : "vem";
              return (
                <div
                  key={c}
                  className={`bx bx-${estado}${alvo === c ? " drop" : ""}${cheia ? " cheia" : ""}`}
                  style={{ ["--c" as string]: CORES_CAIXA[k] }}
                  onDragOver={(e) => {
                    if (cheia) return;
                    e.preventDefault();
                    setAlvo(c);
                  }}
                  onDragLeave={() => setAlvo((a) => (a === c ? null : a))}
                  onDrop={soltarEm(c)}
                >
                  <div className="bx-head">
                    <span className="bx-num">{c}</span>
                    <div className="bx-tit">
                      <strong>Pack {c}</strong>
                      <span>
                        {rotuloHora(j.inicio)} → {rotuloHora(j.fim)}
                        {volta && c === p.caixas && <> · {rotuloHora(0)} → {rotuloHora(p.inicio)}</>}
                      </span>
                    </div>
                    <span className={`bx-badge ${estado}`}>
                      {estado === "live" ? <><i /> No ar</> : estado === "passou" ? "Encerrada" : "A seguir"}
                    </span>
                    {!ocupadas && p.caixas > 1 && c === p.caixas && (
                      <button className="bx-x" onClick={() => p.onRemoverCaixa(c)} title="Remover pack vazio">×</button>
                    )}
                  </div>

                  <div className="bx-slots">
                    {deles.map((e) => {
                      const selo = seloDoEnvio(e, estado, j.inicio, agora);
                      return (
                      <div key={e.id} className={`slot enviado${e.noAr ? " noar" : ""}`}
                        title={`${e.titulo}\n\n${selo.dica}`}>
                        {e.miniatura ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e.miniatura} alt="" loading="lazy" />
                        ) : (
                          <div className="slot-ph">📰</div>
                        )}
                        <span className={`slot-etapa ${selo.classe}`}>
                          <i />
                          {selo.rotulo}
                        </span>
                        {selo.detalhe && <span className="slot-etapa-det">{selo.detalhe}</span>}
                        <span className="slot-tit">{e.titulo}</span>
                        <span className="slot-passos" aria-hidden>
                          {[1, 2, 3].map((n) => (
                            <i key={n} className={n < selo.passo ? "feito" : n === selo.passo ? `atual ${selo.classe}` : ""} />
                          ))}
                        </span>
                        <button
                          className="slot-x"
                          onClick={() => p.onRetirar(e.id, e.titulo)}
                          disabled={p.busy}
                          title="Tirar do pack — sai do ar e libera a vaga"
                        >
                          ×
                        </button>
                      </div>
                      );
                    })}

                    {meus.map((i) => {
                      const it = p.items[i];
                      if (!it) return null;
                      return (
                        <div
                          key={`q${i}`}
                          className={`slot pendente${p.selIdx === i ? " sel" : ""}`}
                          draggable
                          onDragStart={aoArrastar(i)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onDrop={soltarEm(c, i)}
                          onClick={() => p.onSelecionar(i)}
                          title={`${it.title}\nArraste para outro pack`}
                        >
                          {it.imgUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={proxiedImage(it.imgUrl)} alt="" loading="lazy" draggable={false} />
                          ) : (
                            <div className="slot-ph">📰</div>
                          )}
                          {p.enviando?.item === i ? (
                            <span className="slot-etapa sub"><span className="spinner mini" />Enviando</span>
                          ) : (
                            <span className="slot-etapa novo">Na fila</span>
                          )}
                          <span className="slot-tit">{it.title}</span>
                          <button
                            className="slot-x"
                            onClick={(e) => {
                              e.stopPropagation();
                              p.onRemover(i);
                            }}
                            title="Tirar da fila"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}

                    {Array.from({ length: livres }, (_, s) => (
                      <div key={`v${s}`} className="slot vazio">
                        <span>+</span>
                        <em>vaga</em>
                      </div>
                    ))}
                  </div>

                  <div className="bx-foot">
                    <select
                      className="bx-vagas"
                      value={vagas}
                      onChange={(e) => p.onVagas(c, Number(e.target.value))}
                      title="Tamanho do pack — menos vagas, mais exibições para cada notícia"
                    >
                      {Array.from({ length: p.vagasMax }, (_, n) => n + 1).map((v) => (
                        <option key={v} value={v} disabled={v < deles.length}>
                          {v} vaga{v === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                    <div className="bx-meter">
                      {Array.from({ length: vagas }, (_, s) => (
                        <i key={s} className={s < ocupadas ? "on" : ""} />
                      ))}
                    </div>
                    <span>
                      {ocupadas}/{vagas}
                      {fatia > 0 && <> · {fatia} exib./dia cada</>}
                      {repete && (
                        <em className="bx-aviso"
                          title={`A Brato exige que o número de notícias divida as ${p.vagasMax} fatias da unidade`}>
                          {" "}· a 1ª repete
                        </em>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}

            {p.caixas < p.maxCaixas && (
              <button
                className={`bx bx-nova${alvo === 0 ? " drop" : ""}`}
                onClick={p.onNovaCaixa}
                onDragOver={(e) => {
                  e.preventDefault();
                  setAlvo(0);
                }}
                onDragLeave={() => setAlvo((a) => (a === 0 ? null : a))}
                onDrop={soltarEm(p.caixas + 1)}
              >
                <span className="bx-nova-plus">+</span>
                <strong>Novo pack</strong>
                <em>divide o dia em {p.caixas + 1} janelas</em>
              </button>
            )}
          </div>

          <p className="boxes-nota">
            Dentro do pack as notícias revezam <b>uma por exibição</b>, 10 s cada. Na hora da troca
            o sistema passa o próximo pack para o Kuma, mas ele <b>só chega às telas depois da
            publicação no portal</b> (City Lock → Liberar).
            {volta && <> Antes das {rotuloHora(p.inicio)} segue no ar o pack {p.caixas}, o último do dia.</>}
            {retiradas.length > 0 && (
              <span>
                {" "}{retiradas.length} retirada{retiradas.length === 1 ? "" : "s"} do pack hoje.
              </span>
            )}
          </p>

          {parados.length > 0 && (
            <ul className="boxes-alertas">
              {parados.map((e) => (
                <li key={e.id}>
                  <b>⚠ Parada</b>
                  <span className="t">{e.titulo}</span>
                  <span className="m">{e.erro}</span>
                  <code>{e.id}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
