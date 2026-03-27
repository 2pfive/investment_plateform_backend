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
 * Price polling
 */
async function startPriceInterval() {
    interval = setInterval(async () => {
        try {
            // Récupère toutes les quotes via le service
            const quotes = await marketService.getAllQuotes();

            // Transforme si besoin pour le front (ex: calculer isDown)
            const payload = quotes.map(q => ({
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
                isDown: q.change < 0
            }));

            console.log("🟢 Broadcasting to", wss.clients.size, "clients");

            broadcast(payload);

        } catch (err) {
            console.error("Erreur récupération prix:", err);
        }
    }, 15000); // toutes les 15s
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

        const latestPrices = await Promise.all(
            trackedETFs.map(async (etf) => {

                return prisma.prices.findFirst({
                    where: { etf_id: etf.etfId },
                    orderBy: { recorded_at: "desc" }
                });

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