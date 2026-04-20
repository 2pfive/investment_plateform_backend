import { generateToken } from "@/lib/jsonwebtoken.js";
import { prisma } from "@/lib/prisma.js";
import { LoginDTO } from "@/types/dto/auth.dto.js";
import { AppError } from "@/utils/errorHandler.js";
import { comparePasswords, getXafToUsdRate } from "@/utils/utils.js";
import { Accountservice } from "../accounts/account.service.js";
import { UserSession } from "@/types/user.types.js";



export class AuthService {
    private account_service

    constructor() {
        this.account_service = new Accountservice()
        this.login = this.login.bind(this)
        this.getCurrentUser = this.getCurrentUser.bind(this)
    }

    async login(payload: LoginDTO) {
        const { email, password } = payload

        if (!email || !password) throw new AppError("Identifiants de conenxion requis", 400)

        const user = await prisma.user.findUnique({
            where: { email }
        })

        if (!user) throw new AppError("Email ou mot de passe incorrect", 400)

        const same_pswd = await comparePasswords(user.password, password)
        if (!same_pswd) throw new AppError("Email ou mot de passe incorrect", 400)

        // Données de sessions
        if (!user.user_id) throw new AppError("Error on undefined user_id", 400)
        const account = await this.account_service.getBalance(user.user_id)

        const token = await generateToken({
            user_id: user.user_id,
            account_id: account.account.id,
            portfolio_id: account.portfolio.id
        })

        const user_session: UserSession = account as any
        const exchangeRate = await getXafToUsdRate();

        if (exchangeRate && user_session.account) {
            user_session.account.exchangeRate = exchangeRate;
        }

        return {
            user_session,
            token
        }

    }

    async getCurrentUser(userPayload: any) {
        const { user_id } = userPayload

        if (!user_id) {
            throw new AppError("Utilisateur non valide", 401)
        }

        const account = await this.account_service.getBalance(user_id)

        const user_session: UserSession = account as any

        const exchangeRate = await getXafToUsdRate()

        if (exchangeRate && user_session.account) {
            user_session.account.exchangeRate = exchangeRate
        }

        return user_session
    }
}