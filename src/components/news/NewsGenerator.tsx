"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppShell, type ShellStatus } from "@/components/AppShell";
import { useToast } from "@/components/useToast";
import type { DiaNoticias } from "@/app/api/noticias/dia/route";
import { NewsBoxes } from "@/components/news/NewsBoxes";
import { NewsTeste } from "@/components/news/NewsTeste";
import { kumaFilename } from "@/lib/kuma/filename";
import {
  ajustarCortes,
  caixaDaHora,
  cortesDeDuasHoras,
  cortesPadrao,
  DIAS_AGENDA,
  INICIO_DIA,
  MAX_CAIXAS,
} from "@/lib/kuma/noticiaCaixas";
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

  /* Programação do dia: o que já foi enviado hoje e onde cai o que está na fila. */
  const [dia, setDia] = useState<DiaNoticias | null>(null);
  const [carregandoDia, setCarregandoDia] = useState(false);
  const [diaLidoEm, setDiaLidoEm] = useState<number | null>(null);
  const [falhaDia, setFalhaDia] = useState(false);
  /** Envio em andamento: quantas foram, de quantas, e qual notícia do feed está subindo agora. */
  const [enviando, setEnviando] = useState<{ feitas: number; total: number; item: number } | null>(null);
  /** Caixa escolhida à mão (arrastando) para uma notícia da fila. */
  const [escolhidas, setEscolhidas] = useState<Map<number, number>>(new Map());
  /** O dia que a programação mostra: hoje, ou um dos próximos, para agendar. */
  const [dataSel, setDataSel] = useState(() => dataSP(0));
  const dataRef = useRef(dataSel);
  /**
   * A grade que o operador está editando, à frente do servidor. `null` é "vale a
   * gravada". Toda mudança grava sozinha meio segundo depois da última (ver
   * `mudarGrade`), e a edição só volta a `null` quando a gravação confirma — uma
   * releitura que saiu antes não desfaz o que acabou de ser arrastado.
   */
  const [gradeLocal, setGradeLocal] = useState<GradeEditavel | null>(null);
  const [salvamento, setSalvamento] = useState<Salvamento>({ estado: "ok" });
  const edicao = useRef(0);
  const gravadaEm = useRef<string | null>(null);
  const timerSalvar = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /* ── Programação do dia ──────────────────────────────────── */
  const aplicarDia = useCallback((d: DiaNoticias | null) => {
    // Resposta de um dia que já não é o selecionado (troca rápida de aba) não entra.
    if (d && d.data !== dataRef.current) return;
    if (d) {
      setDia((atual) => {
        // Releitura que saiu antes da última gravação chega com a grade velha:
        // fica a que já está na tela.
        const velha =
          atual?.data === d.data &&
          gravadaEm.current !== null &&
          (d.gradeAtualizadaEm ?? "") < gravadaEm.current;
        return velha && atual
          ? {
              ...d,
              cortesGravados: atual.cortesGravados,
              inicio: atual.inicio,
              vagasGravadas: atual.vagasGravadas,
              gradeAtualizadaEm: atual.gradeAtualizadaEm,
            }
          : d;
      });
      setDiaLidoEm(Date.now());
    }
    setFalhaDia(!d);
  }, []);

  const carregarDia = useCallback(async () => {
    aplicarDia(await lerDia(dataRef.current));
    setCarregandoDia(false);
  }, [aplicarDia]);

  const trocarDia = (data: string) => {
    if (data === dataSel) return;
    dataRef.current = data;
    gravadaEm.current = null;
    setDataSel(data);
    setDia(null);
    setGradeLocal(null);
    setEscolhidas(new Map());
  };

  /*
   * Releitura sozinha: a cada 15 s enquanto alguma notícia está subindo ou
   * esperando aprovação — é quando quem opera está olhando o status mudar —, e a
   * cada minuto quando está tudo parado. Trocar de dia lê na hora.
   */
  const emAndamento = (dia?.envios ?? []).some(
    (e) => e.etapa === "propagando" || e.etapa === "em-aprovacao",
  );
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await lerDia(dataRef.current);
      if (!alive) return;
      aplicarDia(d);
      t = setTimeout(() => void tick(), emAndamento ? 15_000 : 60_000);
    };
    t = setTimeout(() => void tick(), dia ? (emAndamento ? 15_000 : 60_000) : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // `dia` fica de fora de propósito: a releitura não reinicia a cada resposta,
    // só quando o ritmo ou o dia mudam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emAndamento, aplicarDia, dataSel]);

  /** O teto de vagas por pack que a frequência comporta (4 com 240). */
  const teto = dia?.vagas ?? 4;
  const vagasChave = (gradeLocal?.vagas ?? dia?.vagasGravadas ?? []).join(",");
  const vagasLista = useMemo(() => (vagasChave ? vagasChave.split(",").map(Number) : []), [vagasChave]);
  /** As vagas de um pack: o tamanho escolhido, ou o teto. */
  const vagasDe = useCallback((c: number) => Math.min(teto, vagasLista[c - 1] ?? teto), [teto, vagasLista]);

  const enviadosPorCaixa = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of dia?.envios ?? []) {
      if (e.etapa !== "parado" && e.etapa !== "retirada") m.set(e.caixa, (m.get(e.caixa) ?? 0) + 1);
    }
    return m;
  }, [dia]);

  /*
   * Toda notícia marcada ganha caixa: a que o operador arrastou, se ainda tiver
   * vaga, e senão a primeira com vaga, contando o que já foi enviado no dia.
   * Encher a última caixa abre a próxima sozinho, que é o "marquei oito, virou
   * duas caixas". Notícia marcada com as caixas todas cheias fica sem caixa, e
   * não vai no envio.
   *
   * Hoje, a busca começa no pack da hora, e não no 1: a vaga que sobrou num pack
   * da manhã (ou que uma retirada abriu) não passa mais na tela, e a notícia
   * cairia nela sem ninguém notar. Na madrugada, antes do pack 1, e nos dias
   * seguintes, tudo ainda está por vir.
   */
  const inicio = gradeLocal?.inicio ?? dia?.inicio ?? INICIO_DIA;
  const primeiraAberta =
    dia?.hoje && dia.hora >= inicio
      ? caixaDaHora(gradeLocal?.cortes ?? dia.cortesGravados ?? dia.cortes, dia.hora, inicio)
      : 1;
  const alocacao = useMemo(() => {
    const m = new Map<number, number>();
    const ocupadas = (c: number) =>
      (enviadosPorCaixa.get(c) ?? 0) + [...m.values()].filter((x) => x === c).length;
    const fila = [...queue].sort((a, b) => a - b);
    for (const i of fila) {
      const c = escolhidas.get(i);
      if (c !== undefined && ocupadas(c) < vagasDe(c)) m.set(i, c);
    }
    for (const i of fila) {
      if (m.has(i)) continue;
      for (let c = primeiraAberta; c <= MAX_CAIXAS; c++) {
        if (ocupadas(c) < vagasDe(c)) {
          m.set(i, c);
          break;
        }
      }
    }
    return m;
  }, [queue, escolhidas, enviadosPorCaixa, vagasDe, primeiraAberta]);

  const cortesBase = gradeLocal?.cortes ?? dia?.cortesGravados ?? null;
  const caixas = Math.max(
    1,
    (cortesBase?.length ?? 0) + 1,
    ...enviadosPorCaixa.keys(),
    ...alocacao.values(),
  );
  const cortes = ajustarCortes(cortesBase ?? cortesPadrao(caixas, inicio), caixas, inicio);
  const vagasPorPack = Array.from({ length: caixas }, (_, k) => vagasDe(k + 1));
  const semVaga = queue.size - alocacao.size;

  /* ── Grade: edição na hora, gravação sozinha ─────────────────── */
  const salvarGrade = useCallback(async (data: string, g: GradeEditavel, seq: number) => {
    setSalvamento({ estado: "salvando" });
    try {
      const r = await fetch(`/api/noticias/dia?data=${data}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(g),
      });
      const corpo = await r.json();
      if (!r.ok) throw new Error(corpo?.error ?? `HTTP ${r.status}`);
      if (data !== dataRef.current) return;
      gravadaEm.current = String(corpo.atualizadoEm ?? new Date().toISOString());
      setDia((d) =>
        d && d.data === data
          ? {
              ...d,
              cortesGravados: g.cortes,
              inicio: g.inicio,
              vagasGravadas: g.vagas,
              gradeAtualizadaEm: gravadaEm.current,
            }
          : d,
      );
      // Só larga a edição se nada mudou enquanto a gravação ia e voltava.
      if (seq === edicao.current) setGradeLocal(null);
      setSalvamento({ estado: "ok", em: Date.now() });
    } catch (e) {
      setSalvamento({ estado: "erro", erro: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const mudarGrade = (parcial: Partial<GradeEditavel>) => {
    const g: GradeEditavel = { cortes, inicio, vagas: vagasPorPack, ...parcial };
    // O tamanho acompanha o número de packs: pack novo nasce com o teto.
    g.vagas = Array.from({ length: g.cortes.length + 1 }, (_, k) => Math.min(teto, g.vagas[k] ?? teto));
    const seq = ++edicao.current;
    setGradeLocal(g);
    setSalvamento({ estado: "salvando" });
    if (timerSalvar.current) clearTimeout(timerSalvar.current);
    const data = dataSel;
    timerSalvar.current = setTimeout(() => void salvarGrade(data, g, seq), 500);
  };

  const tentarSalvarDeNovo = () => {
    const g = gradeLocal ?? { cortes, inicio, vagas: vagasPorPack };
    void salvarGrade(dataSel, g, edicao.current);
  };

  const moverParaCaixa = (item: number, caixa: number, trocarCom?: number) => {
    const de = alocacao.get(item);
    if (de === undefined || de === caixa) return;
    // Fixa a caixa de toda a fila, e não só da que mudou: senão a que foi
    // alocada sozinha poderia pular para a vaga que acabou de abrir.
    const next = new Map(alocacao);
    const ocupadas =
      (enviadosPorCaixa.get(caixa) ?? 0) + [...alocacao.values()].filter((x) => x === caixa).length;
    if (ocupadas < vagasDe(caixa)) {
      next.set(item, caixa);
    } else if (trocarCom !== undefined && trocarCom !== item) {
      // Caixa cheia: soltar em cima de uma notícia troca as duas de lugar.
      next.set(trocarCom, de);
      next.set(item, caixa);
    } else {
      return;
    }
    setEscolhidas(next);
    if (caixa > caixas) mudarGrade({ cortes: ajustarCortes(cortes, caixa, inicio) });
  };

  /** Um pack a cada duas horas, do início ao fim do dia. */
  const deDuasEmDuas = () => {
    const grade = cortesDeDuasHoras(inicio);
    const comNoticia = Math.max(1, ...enviadosPorCaixa.keys(), ...alocacao.values());
    if (grade.length + 1 < comNoticia) {
      toast(`O dia já tem notícia no pack ${comNoticia}, e de 2 em 2 h cabem ${grade.length + 1}.`, "err");
      return;
    }
    mudarGrade({ cortes: grade });
  };

  /** Tamanho de um pack. Não desce abaixo do que já foi enviado para ele. */
  const mudarVagas = (caixa: number, v: number) => {
    const ja = enviadosPorCaixa.get(caixa) ?? 0;
    if (v < ja) {
      toast(`O pack ${caixa} já tem ${ja} notícia(s) enviada(s) — não dá para ter ${v} vaga(s).`, "err");
      return;
    }
    const vs = [...vagasPorPack];
    vs[caixa - 1] = v;
    mudarGrade({ vagas: vs });
  };

  const retirar = async (id: string, titulo: string) => {
    const ok = window.confirm(
      `Tirar do pack “${titulo.slice(0, 80)}”?\n\n` +
        "Ela sai do ar e a vaga fica livre para outra notícia. Não dá para desfazer: " +
        "para voltar, é preciso enviar de novo.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch("/api/noticias/retirar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const corpo = await r.json();
      if (!r.ok) throw new Error(corpo?.error ?? `HTTP ${r.status}`);
      toast("Notícia tirada do pack — a vaga está livre", "ok");
      await carregarDia();
    } catch (e) {
      toast(`Não deu para tirar: ${e instanceof Error ? e.message : e}`, "err");
    } finally {
      setBusy(false);
    }
  };

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
  /** O JPG de um formato, em base64 sem prefixo, como a rota de envio pede. */
  const jpegBase64 = async (item: NewsItem, fmtIndex: number) => {
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

  /** Pack de teste do `ignoreLock`: a notícia selecionada, num prédio só. */
  const enviarTeste = async (predio: { buildingId: string; buildingName: string }, pontos: string[]) => {
    if (!selected) return toast("Selecione uma notícia no feed.", "err");
    const onde = predio.buildingName || `projeto ${predio.buildingId}`;
    const telas = pontos.length ? `no(s) point(s) ${pontos.join(", ")}` : "em todas as telas";
    const ok = window.confirm(
      `Enviar “${selected.title.slice(0, 80)}” como teste do ignoreLock ${telas} de ${onde}?\n\n` +
        "Depois de aprovada no portal, ela ganha um plano e uma unidade só dela, nessas telas, hoje.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch("/api/noticias/publicar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titulo: selected.title,
          duracao: 10,
          teste: { predioId: predio.buildingId, predioNome: predio.buildingName, pontos },
          imagem32: await jpegBase64(selected, 0),
          imagem25: await jpegBase64(selected, 1),
        }),
      });
      const corpo = (await r.json()) as { error?: string; id?: string };
      if (!r.ok) throw new Error(corpo.error ?? `HTTP ${r.status}`);
      toast(`🧪 Teste ${corpo.id} enviado — aparece na Análise Criativa em ~10 min`, "ok");
      await carregarDia();
    } catch (e) {
      toast(`Erro no teste: ${e instanceof Error ? e.message : e}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const enviarParaKuma = async () => {
    // Caixa por caixa, na ordem: se o lote parar no meio, o que subiu é o
    // começo do dia, e não um pedaço de cada janela.
    const fila = [...alocacao.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (!fila.length) return toast("Marque ao menos uma notícia na fila.", "err");

    const base64 = jpegBase64;

    setBusy(true);
    const enviados: number[] = [];
    const falhas: number[] = [];
    try {
      for (const [n, [i, caixa]] of fila.entries()) {
        const item = items[i];
        setStatus({ text: `Enviando ${n + 1}/${fila.length} · pack ${caixa}…` });
        setEnviando({ feitas: n, total: fila.length, item: i });
        try {
          const r = await fetch("/api/noticias/publicar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              titulo: item.title,
              duracao: 10,
              data: dataSel,
              caixa,
              cortes,
              inicio,
              vagas: vagasPorPack,
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
      setEnviando(null);
    }

    if (enviados.length) {
      const feitos = new Set(enviados);
      setQueue((q) => new Set([...q].filter((i) => !feitos.has(i))));
      void carregarDia();
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
            ? " Depois de aprovadas, as notícias de cada pack dividem as exibições da" +
              " janela dela, uma por exibição — a exibição continua sendo de 10 segundos."
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
        {loadingFeed && items.length === 0 ? (
          Array.from({ length: 7 }, (_, k) => (
            <div key={k} className="feed-item feed-skel" aria-hidden>
              <div className="fthumb skel" />
              <div className="finfo">
                <div className="skel skel-line" />
                <div className="skel skel-line curta" />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
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
            disabled={!alocacao.size || busy}>
            {enviando ? (
              <><span className="spinner" /> Enviando {enviando.feitas + 1} de {enviando.total}…</>
            ) : (
              <>🚀 Enviar fila para o Kuma{alocacao.size > 1 ? ` (${alocacao.size})` : ""}</>
            )}
          </button>
          <span className="publicar-nota">
            {alocacao.size
              ? `Envia ${alocacao.size === 1 ? "a notícia marcada" : `as ${alocacao.size} notícias marcadas`} `
                + "nos packs da programação do dia. Cada uma aparece na Análise Criativa "
                + "em ~10 min; depois que você aprovar, ela entra na janela do pack dela."
              : "Marque as notícias na fila para liberar o envio."}
            {semVaga > 0 && (
              <b className="publicar-aviso">
                {" "}{semVaga} marcada{semVaga === 1 ? "" : "s"} sem vaga — os {MAX_CAIXAS} packs do dia estão cheios.
              </b>
            )}
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

      <NewsBoxes
        items={items}
        alocacao={alocacao}
        caixas={caixas}
        maxCaixas={dia?.maxCaixas ?? MAX_CAIXAS}
        vagasPorPack={vagasPorPack}
        vagasMax={teto}
        cortes={cortes}
        inicio={inicio}
        dia={dia}
        carregando={carregandoDia}
        lidoEm={diaLidoEm}
        falhaLeitura={falhaDia}
        enviando={enviando}
        busy={busy}
        selIdx={selIdx}
        salvamento={salvamento}
        onTentarSalvar={tentarSalvarDeNovo}
        dias={DIAS}
        dataSel={dataSel}
        onData={trocarDia}
        onVagas={mudarVagas}
        onMover={moverParaCaixa}
        onRemover={(i) => toggleQueue(i)}
        onRetirar={(id, titulo) => void retirar(id, titulo)}
        onSelecionar={(i) => setSelIdx(i)}
        onCortes={(c) => mudarGrade({ cortes: c })}
        onInicio={(h) => mudarGrade({ inicio: h, cortes: ajustarCortes(cortes, caixas, h) })}
        onDuasHoras={deDuasEmDuas}
        onNovaCaixa={() => mudarGrade({ cortes: ajustarCortes(cortes, Math.min(caixas + 1, MAX_CAIXAS), inicio) })}
        onRemoverCaixa={(c) => mudarGrade({ cortes: ajustarCortes(cortes, Math.max(1, c - 1), inicio) })}
        onEnviar={() => void enviarParaKuma()}
        onAtualizar={() => {
          setCarregandoDia(true);
          void carregarDia();
        }}
      />

      <NewsTeste
        testes={dia?.testes ?? []}
        selecionada={selected?.title ?? null}
        busy={busy}
        onEnviar={enviarTeste}
        onAtualizar={() => void carregarDia()}
      />

      {toastNode}
    </AppShell>
  );
}

type GradeEditavel = { cortes: number[]; inicio: number; vagas: number[] };
export type Salvamento = { estado: "ok" | "salvando" | "erro"; em?: number; erro?: string };

/** `YYYY-MM-DD` em São Paulo, `deslocamento` dias à frente. */
function dataSP(deslocamento = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + deslocamento);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Hoje e os próximos `DIAS_AGENDA` dias, com o rótulo da aba. */
const DIAS = Array.from({ length: DIAS_AGENDA + 1 }, (_, k) => {
  const data = dataSP(k);
  const semana = new Date(`${data}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" });
  const rotulo = k === 0 ? "Hoje" : k === 1 ? "Amanhã" : `${semana.replace(".", "")} ${data.slice(8)}`;
  return { data, rotulo };
});

/** Um dia como o servidor vê. Falha vira `null`: a tela segue com o que tinha. */
async function lerDia(data: string): Promise<DiaNoticias | null> {
  try {
    const r = await fetch(`/api/noticias/dia?data=${data}`, { cache: "no-store" });
    const corpo = await r.json();
    if (!r.ok) throw new Error(corpo?.error ?? `HTTP ${r.status}`);
    return corpo as DiaNoticias;
  } catch (e) {
    console.warn(`[noticias/dia] ${e instanceof Error ? e.message : e}`);
    return null;
  }
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
