import { prisma } from "@/lib/prisma.js";
import { AppError } from "@/utils/errorHandler.js";
export class Accountservice {
    async deposit(amount, user_id) {
        if (!amount || amount <= 0)
            throw new AppError("Le montant doit être supérieur à 0", 400);
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { user_id },
                include: { accounts: true }
            });
            if (!user)
                throw new AppError("Aucun utilisateur trouvé", 404);
            const account = user.accounts[0];
            if (!account)
                throw new AppError("Compte utilisateur non trouvé", 404);
            /**
             * update balance
             */
            const updatedAccount = await tx.accounts.update({
                where: { id: account.id },
                data: {
                    balance: {
                        increment: amount
                    }
                }
            });
            /**
             * enregistrer transaction
             */
            await tx.transactions.create({
                data: {
                    account_id: account.id,
                    amount,
                    type: "deposit"
                }
            });
            return {
                user_id,
                account_id: account.id,
                new_balance: updatedAccount.balance,
                amount
            };
        });
        return {
            message: "Dépôt effectué avec succès",
            data: result
        };
    }
    async getBalance(user_id) {
        if (!user_id) {
            throw new AppError("ID utilisateur requis", 400);
        }
        const account = await prisma.accounts.findFirst({
            where: { user_id },
            select: {
                balance: true,
                currency: true,
                id: true,
                user: {
                    select: {
                        user_id: true,
                        email: true,
                        phone_number: true,
                        birth_date: true
                    }
                }
            }
        });
        if (!account) {
            throw new AppError("Utilisateur non trouvé", 404);
        }
        const portfolio = await prisma.portofolios.findFirst({
            where: { user_id }
        });
        let positions = [];
        if (portfolio) {
            positions = await prisma.positions.findMany({
                where: {
                    portofolio_id: portfolio.id
                },
                select: {
                    quantity: true,
                    avg_buy_price: true,
                    exchange_traded_fund: true
                }
            });
        }
        return {
            account: {
                balance: Number(account.balance),
                currency: account.currency,
                id: account.id,
                user: account.user
            },
            portfolio: {
                id: portfolio?.id,
                positions: positions
            }
        };
    }
}
//# sourceMappingURL=account.service.js.map