import { prisma } from "./prisma.js";
import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import YahooFinance from "yahoo-finance2/src/index.ts";
import { InvestingService } from "@/modules/investing/investing.service.js";
import MarketService from "@/modules/market/market.service.js";

let wss: WebSocketServer;
let interval: NodeJS.Timeout;
let portfolioInterval: NodeJS.Timeout;
const marketService = new MarketService();

/**
 * ETFs suivis
 */
const trackedETFs = [
    { symbol: "QQQ", etfId: "dbfee75b-4d8a-4afc-afb1-44816867b52a" },
    { symbol: "SPY", etfId: "83a63e93-8be3-4727-999f-0b26122db8ea" },
    { symbol: "VT", etfId: "8c0877d5-856b-426c-9309-689bb29cdbb6" }
];

const yf = new YahooFinance();

/**
 * Init websocket
 */
export function initWebSocket(server: HttpServer) {

    wss = new WebSocketServer({ server });

    wss.on("connection", async (socket: WebSocket,req) => {

        console.log("🟢 Client connecté");
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const module = url.searchParams.get("module") || "marketplace";
        console.log(module);
        
        await sendLatestPrices(socket);

        socket.on("close", () => {
            console.log("🔴 Client déconnecté");
        });
    });

    if (!interval) startPriceInterval();
    if (!portfolioInterval) startPortfolioSnapshotInterval();
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
                const qWithMaybeFields = q as Record<string, unknown>;
                const priceValue =
                    ("price" in qWithMaybeFields ? qWithMaybeFields.price : undefined) ??
                    (q as { price?: unknown }).price;
                const changeValue =
                    ("change" in qWithMaybeFields ? qWithMaybeFields.change : undefined) ??
                    (q as { change?: unknown }).change;
                const changePercentValue =
                    ("changePercent" in qWithMaybeFields ? qWithMaybeFields.changePercent : undefined) ??
                    (q as { changePercent?: unknown }).changePercent;
                const ytdValue =
                    ("ytd" in qWithMaybeFields ? qWithMaybeFields.ytd : undefined) ??
                    (q as { ytd?: unknown }).ytd;
                const low52Value =
                    ("low52" in qWithMaybeFields ? qWithMaybeFields.low52 : undefined) ??
                    (q as { low52?: unknown }).low52;
                const high52Value =
                    ("high52" in qWithMaybeFields ? qWithMaybeFields.high52 : undefined) ??
                    (q as { high52?: unknown }).high52;
                const volumeValue =
                    ("volume" in qWithMaybeFields ? qWithMaybeFields.volume : undefined) ??
                    (q as { volume?: unknown }).volume;
                const expenseRatioValue =
                    ("expenseRatio" in qWithMaybeFields ? qWithMaybeFields.expenseRatio : undefined) ??
                    ("expense_ratio" in qWithMaybeFields ? qWithMaybeFields.expense_ratio : undefined) ??
                    (q as { expenseRatio?: unknown; expense_ratio?: unknown }).expenseRatio ??
                    (q as { expenseRatio?: unknown; expense_ratio?: unknown }).expense_ratio;
                const trailingThreeMonthReturnsValue =
                    ("trailingThreeMonthReturns" in qWithMaybeFields
                        ? qWithMaybeFields.trailingThreeMonthReturns
                        : undefined) ?? (q as { trailingThreeMonthReturns?: unknown }).trailingThreeMonthReturns;

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
                await prisma.prices.create({
                    data: {
                        etf_id: q.id,   // ou q.etfId selon l’objet
                        price: priceValue as number,
                        recorded_at: new Date()
                    }
                });
            }

            console.log("🟢 Broadcasting to", wss.clients.size, "clients");
            broadcast(payload);

        } catch (err) {
            console.error("Erreur récupération/enregistrement prix:", err);
        }
    }, 15000);
}

/**
 * Broadcast safe
 */
function broadcast(data: any) {

    if (!wss) return;

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

async function sendLatestPrices(socket: WebSocket) {
    try {
        // Récupère tous les ETFs suivis depuis la base
        const etfs = await prisma.exchange_traded_fund.findMany({
            select: { id: true, symbol: true, name: true }
        });

        if (!etfs.length) return;

        const latestPrices = await Promise.all(
            etfs.map(async (etf) => {
                const price = await prisma.prices.findFirst({
                    where: { etf_id: etf.id },
                    orderBy: { recorded_at: "desc" }
                });

                const priceWithMaybeFields = price as (typeof price & Record<string, unknown>) | null;
                const change =
                    priceWithMaybeFields && "change" in priceWithMaybeFields
                        ? priceWithMaybeFields.change
                        : null;
                const changePercent =
                    priceWithMaybeFields && "changePercent" in priceWithMaybeFields
                        ? priceWithMaybeFields.changePercent
                        : null;
                const ytd =
                    priceWithMaybeFields && "ytd" in priceWithMaybeFields ? priceWithMaybeFields.ytd : null;
                const low52 =
                    priceWithMaybeFields && "low52" in priceWithMaybeFields ? priceWithMaybeFields.low52 : null;
                const high52 =
                    priceWithMaybeFields && "high52" in priceWithMaybeFields ? priceWithMaybeFields.high52 : null;
                const volume =
                    priceWithMaybeFields && "volume" in priceWithMaybeFields ? priceWithMaybeFields.volume : null;
                const expenseRatio =
                    priceWithMaybeFields && "expenseRatio" in priceWithMaybeFields
                        ? priceWithMaybeFields.expenseRatio
                        : null;
                const trailingThreeMonthReturns =
                    priceWithMaybeFields && "trailingThreeMonthReturns" in priceWithMaybeFields
                        ? priceWithMaybeFields.trailingThreeMonthReturns
                        : null;

                return {
                    etfId: etf.id,
                    symbol: etf.symbol,
                    name: etf.name,
                    price: price?.price ?? null,
                    change: change ?? null,
                    changePercent: changePercent ?? null,
                    ytd: ytd ?? null,
                    low52: low52 ?? null,
                    high52: high52 ?? null,
                    volume: volume ?? null,
                    expenseRatio: expenseRatio ?? null,
                    isDown: typeof change === "number" ? change < 0 : false,
                    trailingThreeMonthReturns: trailingThreeMonthReturns ?? null
                };
            })
        );

        socket.send(JSON.stringify(latestPrices));

    } catch (err) {
        console.error("Erreur envoi derniers prix:", err);
    }
}


function startPortfolioSnapshotInterval() {

    portfolioInterval = setInterval(async () => {

        try {

            const portfolios = await prisma.portofolios.findMany({
                select: { id: true }
            });

            for (const portfolio of portfolios) {

                await InvestingService.createPortfolioSnapshot(portfolio.id);

            }

        } catch (err) {
            console.error("Erreur snapshot portefeuille:", err);
        }

    }, 900000);

} 


const getLivePrice = (res: any) => {
    switch (res.marketState) {
        case "REGULAR":
            return res.regularMarketPrice

     
        case "CLOSED":
            return res.postMarketPrice ?? res.regularMarketPrice

        case "PRE":
            return res.preMarketPrice ?? res.regularMarketPrice

        default:
            return res.regularMarketPrice
    }
}