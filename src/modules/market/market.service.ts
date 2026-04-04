// services/MarketService.ts
import { prisma } from "@/lib/prisma.js";
import { AppError } from "@/utils/errorHandler.js";
import YahooFinance from "yahoo-finance2";


class MarketService {

    async getAll() {
        const etfs = await prisma.exchange_traded_fund.findMany();
        if (!etfs || etfs.length === 0) throw new AppError("ETFs not found", 404);
        return etfs;
    }

    // Récupérer les quotes Yahoo pour un symbole
    async getQuote(symbol: string) {
        const yf = new YahooFinance();
        const quote = await yf.quote(symbol);
        return quote;
    }

    // Récupérer les quotes pour tous les ETF
    async getAllQuotes() {
        const etfs = await this.getAll();
        const quotes = await Promise.all(
            etfs.map(async (etf) => {
                try {
                    const quote = await this.getQuote(etf.symbol);
                    return {
                        ...etf,
                        price: quote.regularMarketPrice,
                        change: quote.regularMarketChange,
                        changePercent: quote.regularMarketChangePercent,
                        ytd: quote.ytdReturn,
                        low52: quote.fiftyTwoWeekLow,
                        high52: quote.fiftyTwoWeekHigh,
                        volume: quote.regularMarketVolume,
                        expenseRatio: quote.netExpenseRatio,
                        trailingThreeMonthReturns:quote.trailingThreeMonthReturns
                    };
                } catch (err) {
                    console.error(`Erreur Yahoo pour ${etf.symbol}:`, err);
                    return { ...etf, quote: null };
                }
            })
        );
        return quotes;
    }

    async getDetailsByEtfId(etf_id: string) {
        if (!etf_id) throw new AppError("etf_id requis", 400)

        const etf = await prisma.exchange_traded_fund.findUnique({
            where: {
                id: etf_id
            },
            select: {
                id: true,
                symbol: true,
                name: true,
                currency: true,
                provider: true,
                description: true,
                inception_date: true,

                prices: {
                    orderBy: {
                        recorded_at: 'desc'
                    },
                    take: 1 // dernier prix uniquement
                },

                etf_holding: {
                    select: {
                        name: true,
                        symbol: true,
                        weight: true
                    },
                    orderBy: {
                        weight: 'desc'
                    }
                }
            }
        })

        if (!etf) throw new AppError("ETF introuvable", 404)
        
        return etf
    }

    // async getEtfPerformance(etf_id: string, period: '1D' | '1M' | '3M' | '1Y' = '1M') {
    //     if (!etf_id) throw new AppError("etf_id requis", 400)

    //     const now = new Date()

    //     const periodConfig: Record<string, { days: number; aggregate: boolean; step: number }> = {
    //         '1D': { days: 1,   aggregate: false, step: 2   }, // 1 point / 30s (~2880 pts)
    //         '1M': { days: 30,  aggregate: false,  step: 4   }, // 1 point / jour (~30 pts)
    //         '3M': { days: 90,  aggregate: true,  step: 1   }, // 1 point / jour (~90 pts)
    //         '1Y': { days: 365, aggregate: true,  step: 1   }, // 1 point / jour (~365 pts)
    //     }

    //     const { days, aggregate, step } = periodConfig[period] ?? periodConfig['1M']
    //     const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    //     const prices = await prisma.prices.findMany({
    //         where: { etf_id, recorded_at: { gte: fromDate } },
    //         orderBy: { recorded_at: 'asc' },
    //         select: { price: true, recorded_at: true }
    //     })

    //     if (!prices.length) return []

    //     let points: { date: Date; close: number }[]

    //     if (aggregate) {
    //         // 1M / 3M / 1Y → prix de clôture par jour
    //         const buckets = new Map<string, { close: number; date: Date }>()

    //         for (const p of prices) {
    //             const d = p.recorded_at
    //             const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    //             buckets.set(key, { close: Number(p.price), date: d })
    //         }

    //         points = Array.from(buckets.values())
    //     } else {
    //         // 1D → 1 point toutes les N entrées (contrôle densité via step)
    //         points = prices
    //             .filter((_, i) => i % step === 0)
    //             .map(p => ({ date: p.recorded_at, close: Number(p.price) }))
    //     }

    //     const firstPrice = points[0].close

    //     return points.map(p => ({
    //         x: p.date,
    //         y: Number(((p.close - firstPrice) / firstPrice * 100).toFixed(2))
    //     }))
    // }

    async getEtfPerformance(
        symbol: string,
        period: '1D' | '1M' | '3M' | '1Y' = '1M'
    ) {
        if (!symbol) throw new AppError("symbol requis", 400)

            const config = {
                '1D': { range: '1d', interval: '5m' },
                '1M': { range: '1mo', interval: '1d' },
                '3M': { range: '3mo', interval: '1d' },
                '1Y': { range: '1y', interval: '1d' },
                'MAX': { range: 'max', interval: '1d' },
            }

        const { range, interval } = config[period] ?? config['1M']

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        })

        const json = await response.json()

        const result = json?.chart?.result?.[0]

        const timestamps = result?.timestamp
        const closes = result?.indicators?.quote?.[0]?.close

        if (!timestamps || !closes) return []

        const points = closes
            .map((price: number, i: number) => {
                const ts = timestamps[i]
                if (price == null || ts == null) return null

                return {
                    date: new Date(ts * 1000),
                    close: price
                }
            })
            .filter(Boolean)

        if (!points.length) return []

        const firstPrice = points[0].close

        return points.map(p => ({
            x: p.date,
            y: Number(((p.close - firstPrice) / firstPrice * 100).toFixed(2))
        }))
    }
}

const formatPerformance = (prices: any[]) => {
    if (!prices?.length) return []

    const firstPrice = Number(prices[0].price)

    return prices.map(p => ({
        x: p.recorded_at,
        y: ((Number(p.price) - firstPrice) / firstPrice) * 100
    }))
}

export default MarketService;