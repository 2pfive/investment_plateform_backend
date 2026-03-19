import { prisma } from "lib/prisma.js";
import Decimal from "decimal.js";
import { AppError } from "@/utils/errorHandler.js";

export class InvestingService {

    /**
     * Investir par montant
     */
    async investByAmount({
        user_id,
        etf_id,
        amount_to_invest
    }: {
        user_id: string,
        etf_id: string,
        amount_to_invest: number
    }) {

        if (amount_to_invest <= 0)
            throw new AppError("Montant d'investissement invalide", 400);

        const result = await prisma.$transaction(async (tx) => {

            // User
            const user = await tx.user.findUnique({
                where: { user_id },
                include: {
                    accounts: true,
                    portofolios: true
                }
            });

            if (!user)
                throw new AppError("Utilisateur non trouvé", 404);

            const account = user.accounts[0];

            if (!account)
                throw new AppError("Compte utilisateur non trouvé", 404);

            // Portfolio
            let portfolio = user.portofolios[0];

            if (!portfolio) {
                portfolio = await tx.portofolios.create({
                    data: { user_id }
                });
            }

            // Fresh account balance
            const freshAccount = await tx.accounts.findUnique({
                where: { id: account.id }
            });

            if (!freshAccount)
                throw new AppError("Compte introuvable", 404);

            if (!freshAccount.balance ||
                freshAccount.balance.lt(amount_to_invest)
            ) {
                throw new AppError("Solde insuffisant", 400);
            }

            // Price ETF
            const lastPriceRecorded = await tx.prices.findFirst({
                where: { etf_id },
                orderBy: { recorded_at: "desc" }
            });

            if (!lastPriceRecorded)
                throw new AppError("Prix ETF non disponible", 406);

            const currentPrice = new Decimal(
                lastPriceRecorded.price.toString()
            );

            const investAmountDecimal = new Decimal(amount_to_invest);

            const quantityBought =
                investAmountDecimal.div(currentPrice);

            // Position
            const position = await tx.positions.findFirst({
                where: {
                    portofolio_id: portfolio.id,
                    etf_id
                }
            });

            if (position) {

                const oldTotalValue =
                    new Decimal(position.avg_buy_price.toString())
                        .times(position.quantity.toString());

                const newTotalValue =
                    oldTotalValue.plus(investAmountDecimal);

                const newQuantity =
                    new Decimal(position.quantity.toString())
                        .plus(quantityBought);

                const newAvgPrice =
                    newTotalValue.div(newQuantity);

                await tx.positions.update({
                    where: { id: position.id },
                    data: {
                        quantity: newQuantity.toNumber(),
                        avg_buy_price: newAvgPrice.toNumber()
                    }
                });

            } else {

                await tx.positions.create({
                    data: {
                        portofolio_id: portfolio.id,
                        etf_id,
                        quantity: quantityBought.toNumber(),
                        avg_buy_price: currentPrice.toNumber()
                    }
                });
            }

            // Debit account
            await tx.accounts.update({
                where: { id: account.id },
                data: {
                    balance: {
                        decrement: amount_to_invest
                    }
                }
            });

            // Transaction history
            await tx.transactions.create({
                data: {
                    account_id: account.id,
                    amount: amount_to_invest,
                    type: "buy"
                }
            });

            return {
                quantityBought: quantityBought.toNumber(),
                current_price: currentPrice.toNumber(),
                remainingBalance:
                    freshAccount.balance
                        .minus(amount_to_invest)
                        .toNumber()
            };

        });

        return {
            message: "Investissement effectué avec succès",
            data: result
        };
    }


   static async calculatePortfolioValue(portfolioId: string) {

        const positions = await prisma.positions.findMany({
            where: { portofolio_id: portfolioId }
        });

        if(!positions){
            return 
        }
        
        let totalValue = 0;

        for (const pos of positions) {

            const price = await prisma.prices.findFirst({
                where: { etf_id: pos.etf_id },
                orderBy: { recorded_at: "desc" }
            });

            if (!price) continue;

            totalValue += Number(pos.quantity) * Number(price.price);
        }

        return totalValue;
    }


   static async  createPortfolioSnapshot(portfolioId: string) {

        const value = await InvestingService.calculatePortfolioValue(portfolioId);
        if(value)
            await prisma.portofolio_snapshots.create({
                data: {
                    portofolio_id: portfolioId,
                    portofolio_value: value
                }
            });
        
    }

    /**
     * Performance engine
     */
    // async getAllPerformances(portfolio_id: string) {

    //     const now = new Date();

    //     if (!portfolio_id)
    //         throw new AppError("portfolio_id requis", 400);

    //     const positions = await prisma.positions.findMany({
    //         where: { portofolio_id: portfolio_id }
    //     });

    //     if (!positions.length)
    //         throw new AppError(
    //             "Aucune position trouvée pour ce portfolio",
    //             400
    //         );

    //     /**
    //      * Pre compute portfolio stats (IMPORTANT PERFORMANCE OPTIMIZATION)
    //      */
    //     let totalQuantity = new Decimal(0);
    //     let totalInvested = new Decimal(0);
    //     const etfIds = positions.map(p => p.etf_id);

    //     for (const pos of positions) {

    //         const qty = new Decimal(pos.quantity.toString());
    //         const avg = new Decimal(pos.avg_buy_price.toString());

    //         totalQuantity = totalQuantity.plus(qty);
    //         totalInvested = totalInvested.plus(qty.times(avg));
    //     }

    //     /**
    //      * Performance calculator
    //      */
    //     const calculatePerformance = async (startDate: Date, portfolio_id: string) => {

    //         const positions = await prisma.positions.findMany({
    //             where: { portofolio_id: portfolio_id }
    //         });

    //         if (!positions.length) return { cumulative: [], relative: [] };

    //         const etfIds = positions.map(p => p.etf_id);

    //         const prices = await prisma.prices.findMany({
    //             where: {
    //                 etf_id: { in: etfIds },
    //                 recorded_at: {
    //                     gte: startDate,
    //                     lte: now
    //                 }
    //             },
    //             orderBy: {
    //                 recorded_at: "asc"
    //             }
    //         });

    //         const positionMap = new Map();

    //         let totalInvested = new Decimal(0);

    //         for (const pos of positions) {
    //             const qty = new Decimal(pos.quantity.toString());
    //             const avg = new Decimal(pos.avg_buy_price.toString());

    //             positionMap.set(pos.etf_id, {
    //                 quantity: qty
    //             });

    //             totalInvested = totalInvested.plus(qty.times(avg));
    //         }

    //         /**
    //          * ⭐ Group prices by hour
    //          */
    //         const hourMap = new Map<string, any>();

    //         for (const price of prices) {

    //             const hourKey = new Date(price.recorded_at);
    //             hourKey.setMinutes(0, 0, 0);

    //             const key = hourKey.toISOString();

    //             if (!hourMap.has(key)) {
    //                 hourMap.set(key, []);
    //             }

    //             hourMap.get(key).push(price);
    //         }

    //         let cumulative: any[] = [];
    //         let relative: any[] = [];

    //         /**
    //          * Calculate portfolio value per hour
    //          */
    //         for (const [hour, priceList] of hourMap) {

    //             let portfolioValue = new Decimal(0);

    //             for (const pricePoint of priceList) {

    //                 const pos = positionMap.get(pricePoint.etf_id);
    //                 if (!pos) continue;

    //                 const price = new Decimal(pricePoint.price.toString());

    //                 portfolioValue =
    //                     portfolioValue.plus(
    //                         price.times(pos.quantity)
    //                     );
    //             }

    //             const pl = portfolioValue.minus(totalInvested);

    //             cumulative.push({
    //                 date: hour,
    //                 value: portfolioValue.toNumber()
    //             });

    //             relative.push({
    //                 date: hour,
    //                 value: pl.toNumber()
    //             });
    //         }

    //         return {
    //             cumulative,
    //             relative
    //         };
    //     };
    //     /**
    //      * Time windows (CORRECT FINANCE LOGIC)
    //      */

    //     const hourlyStart = new Date();
    //     hourlyStart.setDate(hourlyStart.getDate() - 7);

    //     const dailyStart = new Date();
    //     dailyStart.setDate(dailyStart.getDate() - 7);

    //     const monthlyStart = new Date();
    //     monthlyStart.setDate(monthlyStart.getDate() - 30);

    //     const yearlyStart = new Date();
    //     yearlyStart.setDate(yearlyStart.getDate() - 365);

    //     return {
    //         hourly: await calculatePerformance(hourlyStart,portfolio_id),
    //         daily: await calculatePerformance(dailyStart,portfolio_id),
    //         monthly: await calculatePerformance(monthlyStart,portfolio_id),
    //         yearly: await calculatePerformance(yearlyStart,portfolio_id)
    //     };
    // }

    async getAllPerformances(portfolio_id: string) {

        try {
    
            if (!portfolio_id)
                throw new AppError("portfolio_id requis", 400)
    
            const now = new Date()
    
            const ranges = {
                "1D": { days: 1, bucket: "hour" },
                "1W": { days: 7, bucket: "day" },
                "1M": { days: 30, bucket: "day" },
                "1Y": { days: 365, bucket: "month" }
            }
    
            const result: any = {}
    
            for (const [range, config] of Object.entries(ranges)) {
    
                const start = new Date(
                    now.getTime() - config.days * 24 * 60 * 60 * 1000
                )
    
                const snapshots = await prisma.portofolio_snapshots.findMany({
                    where: {
                        portofolio_id: portfolio_id,
                        recorded_at: {
                            gte: start,
                            lte: now
                        }
                    },
                    orderBy: {
                        recorded_at: "asc"
                    }
                })
    
                let points: any[] = []
    
                if (config.bucket === "hour") {

                    const interval = 60 * 60 * 1000 // 1 heure
                    let snapshotIndex = 0
                    let lastValue: number | null = null
                
                    const startHour = new Date(start)
                    startHour.setMinutes(0, 0, 0)
                
                    const endHour = new Date(now)
                    endHour.setMinutes(0, 0, 0)
                
                    for (
                        let t = startHour.getTime();
                        t <= endHour.getTime();
                        t += interval
                    ) {
                
                        while (
                            snapshotIndex < snapshots.length &&
                            new Date(snapshots[snapshotIndex].recorded_at).getTime() <= t
                        ) {
                            lastValue = Number(snapshots[snapshotIndex].portofolio_value)
                            snapshotIndex++
                        }
                
                        points.push({
                            t: new Date(t),
                            v: lastValue
                        })
                    }
                
                    result[range] = {
                        interval,
                        points
                    }
                
                    continue
                }
    
                /**
                 * Bucket day / month
                 */
    
                const bucketMap = new Map<string, number>()
    
                for (const snap of snapshots) {
    
                    const date = new Date(snap.recorded_at)
    
                    let key: string
    
                    if (config.bucket === "day") {
    
                        key = date.toISOString().slice(0, 10)
    
                    } else {
    
                        key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`
                    }
    
                    bucketMap.set(key, Number(snap.portofolio_value))
                }
    
                /**
                 * Générer buckets propres
                 */
    
                if (config.bucket === "day") {
    
                    for (let i = config.days - 1; i >= 0; i--) {
    
                        const d = new Date(
                            now.getTime() - i * 24 * 60 * 60 * 1000
                        )
    
                        const key = d.toISOString().slice(0, 10)
    
                        points.push({
                            t: new Date(d.setUTCHours(0,0,0,0)),
                            v: bucketMap.get(key) ?? null
                        })
                    }
    
                } else {
    
                    for (let i = 11; i >= 0; i--) {
    
                        const d = new Date(
                            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
                        )
    
                        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    
                        points.push({
                            t: d,
                            v: bucketMap.get(key) ?? null
                        })
                    }
                }
    
                result[range] = {
                    points
                }
    
            }
    
            return result
    
        } catch (error: any) {
    
            throw new AppError(
                error.message || "Erreur récupération performances",
                500
            )
    
        }
    }
}