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
                // Envoie pour le front
                payload.push({
                    id: q.id,
                    symbol: q.symbol,
                    name: q.name,
                    price: q.price,
                    change: q.change,
                    changePercent: q.changePercent,
                    ytd: q.ytd,
                    low52: q.low52,
                    high52: q.high52,
                    volume: q.volume,
                    expenseRatio: q.expenseRatio,
                    isDown: q.change < 0,
                    trailingThreeMonthReturns:q.trailingThreeMonthReturns
                });

                // Enregistrement DB (seulement price)
                await prisma.prices.create({
                    data: {
                        etf_id: q.id,   // ou q.etfId selon l’objet
                        price: q.price,
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

                return {
                    etfId: etf.id,
                    symbol: etf.symbol,
                    name: etf.name,
                    price: price?.price ?? null,
                    change: price?.change ?? null,
                    changePercent: price?.changePercent ?? null,
                    ytd: price?.ytd ?? null,
                    low52: price?.low52 ?? null,
                    high52: price?.high52 ?? null,
                    volume: price?.volume ?? null,
                    expenseRatio: price?.expenseRatio ?? null,
                    isDown: price ? price.change < 0 : null,
                    trailingThreeMonthReturns:price?.trailingThreeMonthReturns ?? null
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