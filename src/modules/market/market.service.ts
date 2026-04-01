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
}

export default MarketService;