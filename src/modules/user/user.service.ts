import { prisma } from "lib/prisma.js";
import { CreateUserDTO } from "types/dto/user.dto.js";
import { hashPassword } from "utils/utils.js";

export class UserService {

    async create(user: CreateUserDTO) {

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
        const hashedPassword = await hashPassword(user.password)

        // Transaction 
        const result = await prisma.$transaction(async (tx) => {

            // Créer user
            const newUser = await tx.user.create({
                data: {
                    email: user.email,
                    password: hashedPassword,
                    phone_number: user.phone_number,
                    birth_date: new Date(user.birth_date),
                    created_at: new Date()
                }
            });

            // Créer compte wallet
            const account = await tx.accounts.create({
                data: {
                    user_id: newUser.user_id!,
                    balance: 0
                }
            });

            // Créer portfolio
            const portfolio = await tx.portofolios.create({
                data: {
                    user_id: newUser.user_id!
                }
            });

            return {
                user: {
                    id: newUser.user_id,
                    email: newUser.email
                },
                account,
                portfolio
            };

        });

        return result;
    }
}