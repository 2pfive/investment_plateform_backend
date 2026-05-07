import { prisma } from "./prisma.js";
import { WebSocketServer, WebSocket } from "ws";
import YahooFinance from "yahoo-finance2/src/index.ts";
import { InvestingService } from "../modules/investing/investing.service.js";
import MarketService from "../modules/market/market.service.js";
let wss;
let interval;
let portfolioInterval;
const marketService = new MarketService();
/**
 * ETFs suivis
 */
const trackedETFs = [
    { symbol: "QQQ", etfId: "dbfee75b-4d8a-4afc-afb1-44816867b52a" },
    { symbol: "SPY", etfId: "83a63e93-8be3-4727-999f-0b26122db8ea" },
    { symbol: "VT", etfId: "8c0877d5-856b-426c-9309-689bb29cdbb6" }
];
const priceStore = new Map();
const yf = new YahooFinance();
/**
 * Init websocket
 */
export function initWebSocket(server) {
    wss = new WebSocketServer({ server });
    wss.on("connection", async (socket, req) => {
        console.log("🟢 Client connecté");
        const url = new URL(req.url, `http://${req.headers.host}`);
        const module = url.searchParams.get("module") || "marketplace";
        console.log(module);
        await sendLatestPrices(socket);
        socket.on("close", () => {
            console.log("🔴 Client déconnecté");
        });
    });
    if (!interval)
        startPriceInterval();
    if (!portfolioInterval)
        startPortfolioSnapshotInterval();
}
/**
 * Price polling avec enregistrement en base (modèle actuel)
 */
async function startPriceInterval() {
    interval = setInterval(async () => {
        try {
            const quotes = await marketService.getAllQuotes();
            const payload = [];
            for (const q of quotes) {
                const qWithMaybeFields = q;
                const priceValue = ("price" in qWithMaybeFields ? qWithMaybeFields.price : undefined) ??
                    q.price;
                const changeValue = ("change" in qWithMaybeFields ? qWithMaybeFields.change : undefined) ??
                    q.change;
                const changePercentValue = ("changePercent" in qWithMaybeFields ? qWithMaybeFields.changePercent : undefined) ??
                    q.changePercent;
                const ytdValue = ("ytd" in qWithMaybeFields ? qWithMaybeFields.ytd : undefined) ??
                    q.ytd;
                const low52Value = ("low52" in qWithMaybeFields ? qWithMaybeFields.low52 : undefined) ??
                    q.low52;
                const high52Value = ("high52" in qWithMaybeFields ? qWithMaybeFields.high52 : undefined) ??
                    q.high52;
                const volumeValue = ("volume" in qWithMaybeFields ? qWithMaybeFields.volume : undefined) ??
                    q.volume;
                const expenseRatioValue = ("expenseRatio" in qWithMaybeFields ? qWithMaybeFields.expenseRatio : undefined) ??
                    ("expense_ratio" in qWithMaybeFields ? qWithMaybeFields.expense_ratio : undefined) ??
                    q.expenseRatio ??
                    q.expense_ratio;
                const trailingThreeMonthReturnsValue = ("trailingThreeMonthReturns" in qWithMaybeFields
                    ? qWithMaybeFields.trailingThreeMonthReturns
                    : undefined) ?? q.trailingThreeMonthReturns;
                // Mise en cache du prix de l'etf
                priceStore.set(q.id, {
                    price: priceValue,
                    symbol: q.symbol,
                    timestamp: Date.now()
                });
                // Envoie pour le front
                payload.push({
                    id: q.id,
                    symbol: q.symbol,
                    name: q.name,
                    price: priceValue,
                    change: changeValue,
                    changePercent: changePercentValue,
                    ytd: ytdValue,
                    low52: low52Value,
                    high52: high52Value,
                    volume: volumeValue,
                    expenseRatio: expenseRatioValue,
                    isDown: typeof changeValue === "number" ? changeValue < 0 : false,
                    trailingThreeMonthReturns: trailingThreeMonthReturnsValue
                });
                // Enregistrement DB (seulement price)
                // await prisma.prices.create({
                //     data: {
                //         etf_id: q.id,   // ou q.etfId selon l’objet
                //         price: priceValue as number,
                //         recorded_at: new Date()
                //     }
                // });
            }
            console.log("🟢 Broadcasting to", wss.clients.size, "clients");
            broadcast(payload);
        }
        catch (err) {
            console.error("Erreur récupération/enregistrement prix:", err);
        }
    }, 15000);
}
/**
 * Broadcast safe
 */
function broadcast(data) {
    if (!wss)
        return;
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}
/**
 * Send latest prices per ETF
 */
async function sendLatestPrices(socket) {
    try {
        const etfs = await prisma.exchange_traded_fund.findMany({
            select: { id: true, symbol: true, name: true }
        });
        if (!etfs.length)
            return;
        // ❌ Supprimé : récupération des prix depuis la base de données
        // const latestPrices = await Promise.all(
        //     etfs.map(async (etf) => {
        //         const price = await prisma.prices.findFirst({
        //             where: { etf_id: etf.id },
        //             orderBy: { recorded_at: "desc" }
        //         });
        //         ...
        //     })
        // );
        // ✅ Prix depuis le cache mémoire uniquement
        // Si le cache est vide (démarrage serveur), fallback Yahoo Finance
        const latestPrices = await Promise.all(etfs.map(async (etf) => {
            // ✅ 1. Cache mémoire
            const cachedPrice = getPriceFromMemory(etf.id);
            if (cachedPrice !== null) {
                return {
                    etfId: etf.id,
                    symbol: etf.symbol,
                    name: etf.name,
                    price: cachedPrice,
                    change: null,
                    changePercent: null,
                    ytd: null,
                    low52: null,
                    high52: null,
                    volume: null,
                    expenseRatio: null,
                    isDown: false,
                    trailingThreeMonthReturns: null
                };
            }
            //  2. Fallback Yahoo Finance si cache vide/expiré
            try {
                const yf = new YahooFinance();
                const quote = await yf.quote(etf.symbol);
                const price = quote?.regularMarketPrice ?? null;
                const change = quote?.regularMarketChange ?? null;
                const changePercent = quote?.regularMarketChangePercent ?? null;
                return {
                    etfId: etf.id,
                    symbol: etf.symbol,
                    name: etf.name,
                    price,
                    change,
                    changePercent,
                    ytd: quote?.trailingAnnualDividendRate ?? null,
                    low52: quote?.fiftyTwoWeekLow ?? null,
                    high52: quote?.fiftyTwoWeekHigh ?? null,
                    volume: quote?.regularMarketVolume ?? null,
                    expenseRatio: quote?.annualReportExpenseRatio ?? null,
                    isDown: typeof change === "number" ? change < 0 : false,
                    trailingThreeMonthReturns: quote?.trailingThreeMonthReturns ?? null
                };
            }
            catch {
                // ETF injoignable, on renvoie null pour ne pas bloquer les autres
                return {
                    etfId: etf.id,
                    symbol: etf.symbol,
                    name: etf.name,
                    price: null,
                    change: null,
                    changePercent: null,
                    ytd: null,
                    low52: null,
                    high52: null,
                    volume: null,
                    expenseRatio: null,
                    isDown: false,
                    trailingThreeMonthReturns: null
                };
            }
        }));
        socket.send(JSON.stringify(latestPrices));
    }
    catch (err) {
        console.error("Erreur envoi derniers prix:", err);
    }
}
function startPortfolioSnapshotInterval() {
    portfolioInterval = setInterval(async () => {
        try {
            console.log("🟢 Snapshot portefeuilles en cours...");
            const portfolios = await prisma.portofolios.findMany({
                select: { id: true }
            });
            for (const portfolio of portfolios) {
                await InvestingService.createPortfolioSnapshot(portfolio.id);
            }
        }
        catch (err) {
            console.error("Erreur snapshot portefeuille:", err);
        }
    }, 900000);
}
const getLivePrice = (res) => {
    switch (res.marketState) {
        case "REGULAR":
            return res.regularMarketPrice;
        case "CLOSED":
            return res.postMarketPrice ?? res.regularMarketPrice;
        case "PRE":
            return res.preMarketPrice ?? res.regularMarketPrice;
        default:
            return res.regularMarketPrice;
    }
};
export function getPriceFromMemory(etfId) {
    const data = priceStore.get(etfId);
    if (!data)
        return null;
    // option TTL (30s)
    if (Date.now() - data.timestamp > 30000) {
        return null;
    }
    return data.price;
}
//# sourceMappingURL=websocket.js.map