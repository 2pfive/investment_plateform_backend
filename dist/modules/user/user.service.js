import { prisma } from "../../lib/prisma.js";
import { hashPassword, getXafToUsdRate } from "../../utils/utils.js";
export class UserService {
    async create(user) {
        if (!user.password) {
            throw new Error("Password required");
        }
        // Vérifier email existant
        const existingUser = await prisma.user.findUnique({
            where: {
                email: user.email
            }
        });
        if (existingUser) {
            throw new Error("Email already exists");
        }
        // Hash password
        const hashedPassword = await hashPassword(user.password);
        // Transaction 
        const result = await prisma.$transaction(async (tx) => {
            // Créer user
            const newUser = await tx.user.create({
                data: {
                    email: user.email,
                    password: hashedPassword,
                    phone_number: user.phone_number,
                    birth_date: new Date(user.birth_date),
                    created_at: new Date(),
                    first_name: user.first_name,
                    last_name: user.last_name
                }
            });
            // Créer compte wallet
            const account = await tx.accounts.create({
                data: {
                    user_id: newUser.user_id,
                    balance: 0
                }
            });
            // Créer portfolio
            const portfolio = await tx.portofolios.create({
                data: {
                    user_id: newUser.user_id
                }
            });
            const exchangeRate = await getXafToUsdRate();
            return {
                account: {
                    id: account.id,
                    balance: account.balance,
                    currency: account.currency,
                    exchangeRate: exchangeRate ?? 0.0017843916054367556,
                    user: {
                        user_id: newUser.user_id,
                        email: newUser.email,
                        phone_number: newUser.phone_number,
                        birth_date: newUser.birth_date,
                        first_name: newUser.first_name,
                        last_name: newUser.last_name,
                    }
                },
                portfolio: {
                    id: portfolio.id,
                    positions: []
                }
            };
        });
        return result;
    }
}
//# sourceMappingURL=user.service.js.map