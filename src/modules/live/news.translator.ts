import axios from "axios";
import { prisma as defaultPrisma } from "@/lib/prisma.js";
import type { NewsArticle } from "@/ports/broker.port.js";

/**
 * ============================================================
 * TRADUCTION DES ACTUALITÉS — DeepL
 * ============================================================
 *
 * Alpaca ne publie ses actualités qu'en anglais. Les titres sont traduits en
 * français par DeepL, une seule fois : la traduction est gardée dans
 * `market_data.news_translations`, indexée par identifiant d'article. Les
 * 500 000 caractères mensuels du forfait gratuit couvrent ainsi largement
 * l'usage.
 *
 * Titre et résumé sont traduits ; l'article complet reste en anglais, chez son
 * éditeur.
 *
 * Sans `DEEPL_API_KEY`, ou si DeepL échoue (quota, panne), le titre anglais
 * est servi tel quel : les actualités ne tombent jamais à cause d'elles.
 */

/** Les clés du forfait gratuit finissent par « :fx » et ont leur propre hôte. */
function endpoint(key: string): string {
  return key.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}

/** Plafond de textes par appel fixé par DeepL. */
const BATCH = 50;

export class NewsTranslator {
  private readonly prisma: typeof defaultPrisma;
  private readonly key: string | undefined;

  constructor(deps: { prisma?: typeof defaultPrisma; key?: string } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
    this.key = deps.key ?? process.env.DEEPL_API_KEY ?? undefined;
  }

  /** Les articles, titres et résumés en français quand c'est possible. Ne lève jamais. */
  async translate(articles: NewsArticle[]): Promise<NewsArticle[]> {
    if (!this.key || articles.length === 0) return articles;

    try {
      const rows = await this.prisma.newsTranslation.findMany({
        where: { articleId: { in: articles.map((a) => a.id) } },
        select: { articleId: true, headline: true, headlineFr: true, summary: true, summaryFr: true }
      });
      const known = new Map(rows.map((row) => [row.articleId, row]));
      // Un titre ou un résumé corrigé par l'éditeur après coup est retraduit.
      const upToDate = (a: NewsArticle) => {
        const row = known.get(a.id);
        return row?.headline === a.headline && row.summary === a.summary;
      };

      const missing = articles.filter((a) => !upToDate(a));
      for (let i = 0; i < missing.length; i += BATCH / 2) {
        // Deux textes au plus par article : titre et résumé.
        const batch = missing.slice(i, i + BATCH / 2);
        const translated = await this.deepl(batch.flatMap((a) => (a.summary ? [a.headline, a.summary] : [a.headline])));
        let j = 0;
        const fresh = batch.map((a) => ({
          articleId: a.id,
          headline: a.headline,
          headlineFr: translated[j++]!,
          summary: a.summary,
          summaryFr: a.summary ? translated[j++]! : null
        }));

        await this.prisma.$transaction(
          fresh.map(({ articleId, ...row }) =>
            this.prisma.newsTranslation.upsert({ where: { articleId }, create: { articleId, ...row }, update: row })
          )
        );
        for (const row of fresh) known.set(row.articleId, row);
      }

      return articles.map((a) => {
        const row = known.get(a.id);
        return upToDate(a) ? { ...a, headline: row!.headlineFr, summary: row!.summaryFr } : a;
      });
    } catch (error) {
      console.warn("[news] traduction impossible :", (error as Error)?.message);
      return articles;
    }
  }

  private async deepl(texts: string[]): Promise<string[]> {
    const { data } = await axios.post<{ translations: { text: string }[] }>(
      endpoint(this.key!),
      { text: texts, source_lang: "EN", target_lang: "FR" },
      { timeout: 8_000, headers: { Authorization: `DeepL-Auth-Key ${this.key}` } }
    );
    if (data.translations?.length !== texts.length) throw new Error("réponse DeepL incomplète");
    return data.translations.map((t) => t.text);
  }
}
