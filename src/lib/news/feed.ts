import type { NewsItem } from "./spec";

/**
 * Converte texto do feed em texto plano: resolve entidades, remove tags
 * e normaliza espaços. DOMParser não carrega recursos, então é seguro
 * para conteúdo de terceiros.
 */
export function plain(str: unknown): string {
  if (!str) return "";
  const doc = new DOMParser().parseFromString(String(str), "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

/**
 * Nomes de campo aceitos, em ordem de preferência. O feed pode mudar os
 * nomes sem quebrar o gerador.
 */
const FIELD_ALIASES: Record<"title" | "editoria" | "credits", string[]> = {
  title: ["title", "headline", "manchete", "titulo"],
  editoria: [
    "imagecategory",
    "editoria",
    "category",
    "section",
    "kicker",
    "subject",
    "categoria",
  ],
  credits: [
    "imagecredits",
    "imagecredit",
    "photocredit",
    "credits",
    "credit",
    "credito",
    "crédito",
    "creditos",
    "créditos",
    "fotocredito",
  ],
};

const IMG_EXT = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

export type ParseResult = {
  items: NewsItem[];
  /** Campos que nenhum item do feed trouxe, para avisar o operador. */
  missing: string[];
  /** Tags encontradas nos itens, útil para diagnosticar um feed novo. */
  tags: string[];
};

export function parseFeed(xmlText: string): ParseResult {
  let xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) {
    xml = new DOMParser().parseFromString(xmlText, "text/xml");
  }
  if (xml.querySelector("parsererror")) throw new Error("XML inválido");

  const nodes = [...xml.querySelectorAll("item, entry")];
  if (!nodes.length) throw new Error("nenhum <item> ou <entry> no feed");

  const tagsVistas = new Set<string>();

  const items: NewsItem[] = nodes.map((node) => {
    // Indexa os filhos do item pelo nome local, em minúsculas.
    const byName: Record<string, Element> = {};
    const els: Element[] = [];
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let el = tw.nextNode() as Element | null; el; el = tw.nextNode() as Element | null) {
      const ln = (el.localName || "").toLowerCase();
      els.push(el);
      tagsVistas.add(ln);
      if (!(ln in byName)) byName[ln] = el;
    }

    const grab = (key: keyof typeof FIELD_ALIASES): string => {
      for (const alias of FIELD_ALIASES[key]) {
        const el = byName[alias];
        if (!el) continue;
        // Atom guarda o valor em atributo: <category term="Clima"/>
        const t =
          plain(el.textContent) ||
          plain(el.getAttribute("term")) ||
          plain(el.getAttribute("label"));
        if (t) return t;
      }
      return "";
    };

    // Fallback do crédito: qualquer tag cujo nome contenha "credit".
    let imageCredits = grab("credits");
    if (!imageCredits) {
      const el = els.find((e) => /credit|cr[ée]dito/i.test(e.localName || ""));
      imageCredits = plain(el?.textContent);
    }

    // Imagem: media:content / media:thumbnail / enclosure / link / <image>
    let imgUrl: string | null = null;
    for (const el of els) {
      const ln = (el.localName || "").toLowerCase();
      const u = el.getAttribute("url") || el.getAttribute("href") || el.getAttribute("src");
      if (!u || !/^https?:/i.test(u)) continue;
      const tipo = (el.getAttribute("type") || el.getAttribute("medium") || "").toLowerCase();
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      const ehImagem =
        /^(content|thumbnail|image)$/.test(ln) ||
        (ln === "enclosure" && (tipo.startsWith("image") || IMG_EXT.test(u))) ||
        (ln === "link" && (rel === "enclosure" || rel === "image") && IMG_EXT.test(u)) ||
        tipo.startsWith("image") ||
        IMG_EXT.test(u);
      if (ehImagem) {
        imgUrl = u;
        break;
      }
    }
    if (!imgUrl) {
      for (const el of els) {
        const t = (el.textContent || "").trim();
        if (/^https?:/i.test(t) && IMG_EXT.test(t)) {
          imgUrl = t;
          break;
        }
      }
    }

    const title = grab("title") || "(sem título)";
    const editoria = grab("editoria");
    return {
      title,
      editoria,
      imageCredits,
      imgUrl,
      orig: { title, editoria, imageCredits },
    };
  });

  const missing: string[] = [];
  if (!items.some((i) => i.editoria)) missing.push("editoria");
  if (!items.some((i) => i.imageCredits)) missing.push("crédito");
  if (!items.some((i) => i.imgUrl)) missing.push("imagem");

  return { items, missing, tags: [...tagsVistas].sort() };
}
