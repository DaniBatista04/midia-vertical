"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell, type ShellStatus } from "@/components/AppShell";
import { useToast } from "@/components/useToast";
import { kumaFilename } from "@/lib/kuma/filename";
import { drawCard, proxiedImage, renderJpeg, type TitleFit } from "@/lib/news/draw";
import { parseFeed } from "@/lib/news/feed";
import {
  CHAR_LIMIT,
  NEWS_DEFAULTS,
  NEWS_FORMATS,
  type NewsControls,
  type NewsItem,
} from "@/lib/news/spec";
import { slugify } from "@/lib/news/text";

const DEFAULT_FEED = "https://api.appnewsdelivery.net/rss-20-latest";

type Dim = { fit: TitleFit; nominal: number } | null;

export function NewsGenerator() {
  const { toast, toastNode } = useToast();

  const [controls, setControls] = useState<NewsControls>({ ...NEWS_DEFAULTS });
  const [rssUrl, setRssUrl] = useState(DEFAULT_FEED);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [queue, setQueue] = useState<Set<number>>(new Set());
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  const [status, setStatus] = useState<ShellStatus>({ text: "Verificando API…" });
  const [dims, setDims] = useState<[Dim, Dim]>([null, null]);
  const [jpgSize, setJpgSize] = useState("—");

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null]);

  const selected = selIdx !== null ? items[selIdx] : undefined;

  const set = useCallback(<K extends keyof NewsControls>(k: K, v: NewsControls[K]) => {
    setControls((c) => ({ ...c, [k]: v }));
  }, []);

  /* ── Checagem das rotas ──────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/health", { signal: AbortSignal.timeout(5000) });
        const ok = (await r.json())?.ok === true;
        if (!alive) return;
        setApiOk(ok);
        setStatus(ok ? { text: "API ativa", ok: true } : { text: "API indisponível", err: true });
        if (ok) setTimeout(() => setBannerHidden(true), 3000);
      } catch {
        if (!alive) return;
        setApiOk(false);
        setStatus({ text: "API indisponível", err: true });
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ── Carregar o feed ─────────────────────────────────────── */
  const loadFeed = useCallback(async () => {
    const url = rssUrl.trim();
    if (!url) return toast("Informe a URL do feed.", "err");

    setLoadingFeed(true);
    setStatus({ text: "Buscando feed…" });
    try {
      const res = await fetch(`/api/feed?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const { items: parsed, missing, tags } = parseFeed(await res.text());
      setItems(parsed);
      setSelIdx(null);
      setQueue(new Set());
      setStatus({ text: `${parsed.length} notícias`, ok: true });
      toast(`${parsed.length} notícias carregadas`, "ok");
      if (missing.length) {
        console.warn(
          `[feed] não encontrei: ${missing.join(", ")}.\nTags disponíveis no item: ${tags.join(", ")}`,
        );
        setTimeout(
          () => toast(`Feed sem ${missing.join(" e ")} — veja as tags no console (F12)`),
          900,
        );
      }
    } catch (e) {
      toast(`Erro ao carregar: ${e instanceof Error ? e.message : e}`, "err");
      setStatus({ text: "Erro no feed", err: true });
    } finally {
      setLoadingFeed(false);
    }
  }, [rssUrl, toast]);

  /* ── Redesenho dos dois previews ─────────────────────────── */
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const t = setTimeout(async () => {
      const next: [Dim, Dim] = [null, null];
      await Promise.all(
        NEWS_FORMATS.map(async (fmt, i) => {
          const cv = canvasRefs.current[i];
          if (!cv) return;
          cv.width = Math.round(fmt.w * fmt.sc);
          cv.height = Math.round(fmt.h * fmt.sc);
          const fit = await drawCard(cv, selected, fmt.sc, fmt, controls, i);
          next[i] = { fit, nominal: i === 0 ? controls.tSize1 : controls.tSize2 };
        }),
      );
      if (alive) setDims(next);
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selected, controls]);

  /* ── Peso estimado do JPG no formato 2560 ────────────────── */
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (!selected) {
        if (alive) setJpgSize("—");
        return;
      }
      setJpgSize("…");
      try {
        const blob = await renderJpeg(selected, NEWS_FORMATS[1], 1, controls);
        if (alive) setJpgSize(`${Math.round(blob.size / 1024)} KB`);
      } catch {
        if (alive) setJpgSize("—");
      }
    }, 260);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selected, controls]);

  /* ── Seleção e fila ──────────────────────────────────────── */
  const selectItem = (i: number) => {
    setSelIdx(i);
    setQueue((q) => new Set(q).add(i));
  };
  const toggleQueue = (i: number) => {
    setQueue((q) => {
      const n = new Set(q);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  };
  const toggleAll = () => {
    setQueue((q) => (q.size === items.length ? new Set() : new Set(items.map((_, i) => i))));
  };

  /* ── Edição dos textos ───────────────────────────────────── */
  const editField = (field: "title" | "editoria" | "imageCredits", value: string) => {
    if (selIdx === null) return;
    setItems((prev) => prev.map((it, i) => (i === selIdx ? { ...it, [field]: value } : it)));
  };
  const restoreFromFeed = () => {
    if (selIdx === null) return;
    setItems((prev) =>
      prev.map((it, i) =>
        i === selIdx
          ? { ...it, title: it.orig.title, editoria: it.orig.editoria, imageCredits: it.orig.imageCredits }
          : it,
      ),
    );
    toast("Textos restaurados do feed");
  };

  /* ── Download ────────────────────────────────────────────── */
  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = filename;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const exportCard = async (item: NewsItem, fmtIndex: number) => {
    const fmt = NEWS_FORMATS[fmtIndex];
    const blob = await renderJpeg(item, fmt, fmtIndex, controls);
    saveBlob(blob, kumaFilename(slugify(item.title), fmt.w, fmt.h, "jpg"));
  };

  /**
   * Manda para a esteira do Kuma todas as notícias marcadas na fila.
   *
   * Renderiza os dois formatos aqui mesmo — é o mesmo `renderJpeg` do download,
   * então o que vai para as telas é exatamente o que está no preview — e sobe
   * pelo corpo da requisição. Cabe porque notícia é imagem: o spec do Kuma
   * limita JPG a 2 MB, e por isso nada disso precisa de runner de CI.
   *
   * Um envio por vez, esperando a resposta antes de mandar o próximo, e não
   * todos em paralelo: a rota descobre o índice do dia procurando o primeiro id
   * livre no bucket, então pedidos simultâneos leriam o bucket antes de qualquer
   * um ter gravado e pegariam o mesmo índice — e nome de material repetido é
   * reprovado pelo Kuma com 502 e feedback vazio.
   *
   * Uma notícia que falha não interrompe as outras: a fila inteira é tentada e o
   * resumo diz quantas passaram. As que passaram saem da fila, para que um
   * segundo clique não crie unidade duplicada.
   *
   * A rota só hospeda e registra. Submeter vem depois, pelo cron, por causa da
   * folga de propagação de dez minutos — ninguém fica de tela aberta esperando.
   */
  const enviarParaKuma = async () => {
    const fila = [...queue].sort((a, b) => a - b);
    if (!fila.length) return toast("Marque ao menos uma notícia na fila.", "err");

    const base64 = async (item: NewsItem, fmtIndex: number) => {
      const blob = await renderJpeg(item, NEWS_FORMATS[fmtIndex], fmtIndex, controls);
      const buf = await blob.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      // Em pedaços: `String.fromCharCode(...bytes)` de uma vez estoura a pilha
      // com arquivo grande.
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return btoa(bin);
    };

    setBusy(true);
    const enviados: number[] = [];
    const falhas: number[] = [];
    try {
      for (const [n, i] of fila.entries()) {
        const item = items[i];
        setStatus({ text: `Enviando ${n + 1}/${fila.length}…` });
        try {
          const r = await fetch("/api/noticias/publicar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              titulo: item.title,
              duracao: 10,
              imagem32: await base64(item, 0),
              imagem25: await base64(item, 1),
            }),
          });
          const corpo = (await r.json()) as { error?: string; id?: string };
          if (!r.ok) throw new Error(corpo.error ?? `HTTP ${r.status}`);
          enviados.push(i);
          toast(`✓ ${n + 1}/${fila.length} — ${corpo.id}`, "ok");
        } catch (e) {
          falhas.push(i);
          toast(
            `Erro em “${item.title.slice(0, 40)}”: ${e instanceof Error ? e.message : e}`,
            "err",
          );
        }
      }
    } finally {
      setBusy(false);
    }

    if (enviados.length) {
      const feitos = new Set(enviados);
      setQueue((q) => new Set([...q].filter((i) => !feitos.has(i))));
    }
    if (falhas.length) {
      setStatus({
        text: `${enviados.length} de ${fila.length} enviadas — ${falhas.length} com erro`,
        err: true,
      });
      toast(`${enviados.length} enviadas, ${falhas.length} com erro`, "err");
    } else {
      setStatus({
        text:
          `${enviados.length} ${enviados.length === 1 ? "notícia hospedada" : "notícias hospedadas"}. ` +
          "O grupo criativo é submetido em cerca de 10 minutos, e depois aparece " +
          "na Análise Criativa para aprovação." +
          // Quem manda quatro de uma vez espera ver as quatro na tela juntas. Não
          // é o que acontece, e é melhor dizer aqui do que a operação descobrir
          // cronometrando: a exibição é de 10s, uma notícia por vez.
          (enviados.length > 1
            ? " Depois de aprovadas elas dividem as exibições do dia, uma notícia" +
              " por exibição — a exibição continua sendo de 10 segundos."
            : ""),
        ok: true,
      });
      if (enviados.length > 1) toast(`✓ ${enviados.length} notícias enviadas`, "ok");
    }
  };

  const downloadSingle = async (fmtIndex: number) => {
    if (!selected) return;
    setBusy(true);
    setStatus({ text: "Gerando JPG…" });
    try {
      await exportCard(selected, fmtIndex);
      const fmt = NEWS_FORMATS[fmtIndex];
      toast(`${fmt.w}×${fmt.h} salvo em JPG`, "ok");
      setStatus({ text: "Pronto", ok: true });
    } catch (e) {
      toast(`Erro ao gerar: ${e instanceof Error ? e.message : e}`, "err");
      setStatus({ text: "Erro", err: true });
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = async () => {
    const sel = [...queue].sort((a, b) => a - b);
    if (!sel.length) return;
    setBusy(true);
    let done = 0;
    let fails = 0;
    for (const i of sel) {
      for (let f = 0; f < NEWS_FORMATS.length; f++) {
        setStatus({ text: `Gerando ${++done}/${sel.length * 2}…` });
        try {
          await exportCard(items[i], f);
          await new Promise((r) => setTimeout(r, 280));
        } catch {
          fails++;
          toast(`Falhou: ${items[i].title.slice(0, 40)}`, "err");
        }
      }
    }
    setStatus({ text: `${done - fails} arquivos gerados`, ok: true });
    toast(
      fails ? `${done - fails} gerados, ${fails} com erro` : `${done} arquivos gerados`,
      fails ? "" : "ok",
    );
    setBusy(false);
  };

  const resetControls = () => {
    setControls({ ...NEWS_DEFAULTS });
    toast("Controles no padrão do template");
  };

  const titleLen = selected?.title.length ?? 0;

  /* ── Sidebar ─────────────────────────────────────────────── */
  const aside = (
    <>
      <div className="slabel">Feed RSS</div>
      <div className="rss-box">
        <input
          type="text"
          value={rssUrl}
          placeholder="URL do feed"
          onChange={(e) => setRssUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadFeed()}
        />
        <button className="btn btn-accent" onClick={loadFeed} disabled={loadingFeed || !apiOk}>
          {loadingFeed ? <><span className="spinner" /> Carregando…</> : "Carregar feed"}
        </button>
      </div>

      <div className="slabel">
        Notícias{" "}
        {items.length > 0 && <span style={{ color: "var(--accent)" }}>({items.length})</span>}
      </div>

      <div className="feed-list">
        {items.length === 0 ? (
          <div className="feed-empty">
            <div style={{ fontSize: 30, opacity: 0.3 }}>📡</div>
            <p>Nenhum feed carregado</p>
          </div>
        ) : (
          items.map((item, i) => {
            const len = item.title.length;
            return (
              <div
                key={i}
                className={`feed-item${i === selIdx ? " active" : ""}${queue.has(i) ? " queued" : ""}`}
                onClick={() => selectItem(i)}
              >
                {item.imgUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="fthumb"
                    src={proxiedImage(item.imgUrl)}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="fthumb-ph">📰</div>
                )}
                <div className="finfo">
                  <div className="ftitle">{item.title}</div>
                  <div className="fmeta">
                    {item.editoria && <div className="feditoria">{item.editoria}</div>}
                    <div className={`fchars${len > CHAR_LIMIT ? " over" : ""}`}>
                      {len}/{CHAR_LIMIT}
                    </div>
                  </div>
                </div>
                <div
                  className="fcheck"
                  title="Adicionar/remover da fila"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleQueue(i);
                  }}
                >
                  {queue.has(i) ? "✓" : ""}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="sfooter">
        <div className="sfooter-count">
          <strong>{queue.size}</strong> na fila · <strong>{items.length}</strong> no feed
        </div>
        <button className="btn btn-ghost btn-sm" onClick={toggleAll} disabled={!items.length}>
          {queue.size === items.length && items.length ? "Desmarcar todas" : "Marcar todas"}
        </button>
        <button className="btn btn-accent" onClick={downloadAll} disabled={!queue.size || busy}>
          Baixar fila (2 formatos)
        </button>

        <div className="publicar-bloco">
          <button className="btn btn-accent" onClick={() => void enviarParaKuma()}
            disabled={!queue.size || busy}>
            🚀 Enviar fila para o Kuma{queue.size > 1 ? ` (${queue.size})` : ""}
          </button>
          <span className="publicar-nota">
            {queue.size
              ? `Envia ${queue.size === 1 ? "a notícia marcada" : `as ${queue.size} notícias marcadas`} `
                + "na fila. Cada uma vira um envio próprio e aparece na Análise Criativa "
                + "em ~10 min; depois que você aprovar, a unidade é criada sozinha."
              : "Marque as notícias na fila para liberar o envio."}
          </span>
        </div>
      </div>
    </>
  );

  const banner = (
    <div className={`api-banner${apiOk ? " ok" : ""}${bannerHidden ? " hidden" : ""}`}>
      <span>{apiOk ? "✓" : "⚠"}</span>
      <span>
        {apiOk === null
          ? "Verificando as rotas do servidor…"
          : apiOk
            ? "Rotas de proxy ativas."
            : "Rotas indisponíveis. Confira se o servidor Next está rodando."}
      </span>
    </div>
  );

  return (
    <AppShell
      app="news"
      logo={<>NEWS<span>CARD</span></>}
      tag={<div className="tag">APP NEWS · DUAL FORMAT</div>}
      status={status}
      banner={banner}
      aside={aside}
    >
      {/* ── Faixa de controles ─────────────────────────────── */}
      <div className="controls-strip">
        <div className="ctrl-group">
          <div className="ctrl-head">Título 32&quot; · 1080×1920</div>
          <Range label="Corpo" min={50} max={110} step={1} unit="px"
            value={controls.tSize1} onChange={(v) => set("tSize1", v)} />
          <Range label="Entrel." min={70} max={140} step={1} unit="px"
            value={controls.tLead1} onChange={(v) => set("tLead1", v)} />
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Título 25&quot; · 1080×2560</div>
          <Range label="Corpo" min={70} max={145} step={1} unit="px"
            value={controls.tSize2} onChange={(v) => set("tSize2", v)} />
          <Range label="Entrel." min={90} max={175} step={1} unit="px"
            value={controls.tLead2} onChange={(v) => set("tLead2", v)} />
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Layout</div>
          <Range label="Marg. X" min={60} max={170} step={1} unit="px"
            value={controls.marginX} onChange={(v) => set("marginX", v)} />
          <Range label="Larg." min={640} max={940} step={1} unit="px"
            title="Largura da coluna de texto — é ela que define as quebras de linha"
            value={controls.boxW} onChange={(v) => set("boxW", v)} />
          <Range label="Foto X" min={-100} max={100} step={1} unit="%"
            value={controls.imgX} onChange={(v) => set("imgX", v)} />
          <div className="ctrl-row">
            <label className="chk" title="Redesenha o título menor quando a manchete não cabe">
              <input type="checkbox" checked={controls.autoFit}
                onChange={(e) => set("autoFit", e.target.checked)} />
              Ajustar corpo automaticamente
            </label>
          </div>
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Brilho da foto</div>
          <div className="ctrl-row">
            <label className="chk" title="Halo branco em volta da foto, para separar do fundo preto">
              <input type="checkbox" checked={controls.glowOn}
                onChange={(e) => set("glowOn", e.target.checked)} />
              Exibir halo
            </label>
          </div>
          <Range label="Difusão" min={0} max={120} step={1} unit="px"
            value={controls.glowBlur} onChange={(v) => set("glowBlur", v)} />
          <Range label="Força" min={5} max={100} step={1} unit="%"
            value={controls.glowOp} onChange={(v) => set("glowOp", v)} />
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Cores</div>
          <div className="ctrl-row">
            <span className="clabel">Editoria</span>
            <Swatch value={controls.edColor} onChange={(v) => set("edColor", v)} />
            <span className="clabel" style={{ marginLeft: 8 }}>Título</span>
            <Swatch value={controls.titleColor} onChange={(v) => set("titleColor", v)} />
          </div>
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Crédito da foto</div>
          <div className="ctrl-row">
            <label className="chk">
              <input type="checkbox" checked={controls.credOn}
                onChange={(e) => set("credOn", e.target.checked)} />
              Exibir
            </label>
            <Swatch value={controls.credColor} onChange={(v) => set("credColor", v)} />
          </div>
          <Range label="Corpo" min={12} max={34} step={0.1} unit="px" decimals={1}
            value={controls.credSize} onChange={(v) => set("credSize", v)} />
        </div>

        <div className="ctrl-group">
          <div className="ctrl-head">Export JPG</div>
          <Range label="Qualid." min={60} max={100} step={1} unit="%"
            title="Acima de 90% o QR-Code sai limpo. Abaixo de 80% os módulos começam a borrar."
            value={controls.jpgQ} onChange={(v) => set("jpgQ", v)} />
          <div className="ctrl-row">
            <span className="clabel" style={{ color: "#8a8a8a" }}>Peso</span>
            <span className="rval" style={{ minWidth: 74, textAlign: "left" }}>{jpgSize}</span>
          </div>
        </div>

        <div className="ctrl-group last">
          <button className="btn btn-ghost btn-sm" onClick={resetControls}>
            Voltar ao padrão
          </button>
        </div>
      </div>

      {/* ── Barra de edição ────────────────────────────────── */}
      {selected && (
        <div className="edit-bar">
          <div className="efield grow">
            <div className="efield-head">
              <label htmlFor="eTitle">Manchete</label>
              <span className={`ecount${titleLen > CHAR_LIMIT ? " over" : ""}`}>
                {titleLen}/{CHAR_LIMIT}
              </span>
            </div>
            <input id="eTitle" type="text" value={selected.title}
              placeholder="Manchete do card"
              onChange={(e) => editField("title", e.target.value)} />
          </div>
          <div className="efield" style={{ width: 210 }}>
            <div className="efield-head"><label htmlFor="eEd">Editoria</label></div>
            <input id="eEd" type="text" value={selected.editoria}
              placeholder="Ex.: Segurança e Cidadania"
              onChange={(e) => editField("editoria", e.target.value)} />
          </div>
          <div className="efield" style={{ width: 210 }}>
            <div className="efield-head"><label htmlFor="eCred">Crédito da foto</label></div>
            <input id="eCred" type="text" value={selected.imageCredits}
              placeholder="Ex.: © Dan Race/Adobe Stock"
              onChange={(e) => editField("imageCredits", e.target.value)} />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={restoreFromFeed}
            title="Volta aos textos originais do feed">
            Restaurar do feed
          </button>
        </div>
      )}

      {/* ── Previews ───────────────────────────────────────── */}
      <div className="canvas-area">
        {NEWS_FORMATS.map((fmt, i) => {
          const d = dims[i];
          const previewW = Math.round(fmt.w * fmt.sc);
          const previewH = Math.round(fmt.h * fmt.sc);
          return (
            <div className="canvas-col" key={fmt.label}>
              <div className="col-header">
                <span className={`format-chip ${fmt.chip}`}>{fmt.w} × {fmt.h}</span>
                <span className="col-title">{fmt.label}</span>
              </div>
              <div className="canvas-wrap">
                <canvas
                  ref={(el) => { canvasRefs.current[i] = el; }}
                  width={previewW}
                  height={previewH}
                />
                {!selected && (
                  <div className="empty-overlay">
                    <div className="ei">🖼</div>
                    <p style={{ fontSize: 11 }}>Selecione uma notícia</p>
                  </div>
                )}
              </div>
              <div className="canvas-dim">
                Preview {previewW}×{previewH} · export {fmt.w}×{fmt.h}
                {d && (
                  <>
                    <br />
                    {d.fit.lines.length}/{d.fit.maxLines} linhas ·{" "}
                    {d.fit.shrunk ? (
                      <span className="shrunk">corpo {d.fit.size}px (nominal {d.nominal})</span>
                    ) : (
                      <>corpo {d.fit.size}px</>
                    )}
                    {d.fit.overflow && <> · <span className="shrunk">não cabe no formato</span></>}
                  </>
                )}
              </div>
              <div className="dl-row">
                <button className="btn btn-accent btn-sm"
                  onClick={() => downloadSingle(i)} disabled={!selected || busy}>
                  Baixar JPG {fmt.w}×{fmt.h}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {toastNode}
    </AppShell>
  );
}

/* ── Controles reutilizáveis ───────────────────────────────── */
function Range({
  label, min, max, step, value, unit, onChange, title, decimals = 0,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
  title?: string;
  decimals?: number;
}) {
  return (
    <div className="ctrl-row">
      <span className="clabel" title={title}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="rval">{value.toFixed(decimals)}</span>
      <span className="runit">{unit}</span>
    </div>
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
