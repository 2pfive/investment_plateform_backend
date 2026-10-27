import { AppError } from "@/utils/errorHandler.js"
import { AuthService } from "./auth.service.js"
import { Response, Request, CookieOptions } from "express"
import { config } from "@/config/env.js"
import { prisma } from "@/lib/prisma.js"
import { recordAudit } from "@/modules/admin/admin.audit.js"

export class AuthControllers {
    private authService
    constructor() {
        this.authService = new AuthService()
        this.loginController = this.loginController.bind(this)
        this.verifyCurrentUser = this.verifyCurrentUser.bind(this)
        this.logoutController = this.logoutController.bind(this)
    }
    static setCookie(res: Response, name: string, value: any, options: CookieOptions = {}) {
        const isProduction=process.env.NODE_ENV === "production"
        const defaultOptions: CookieOptions = {
            httpOnly: true,
            maxAge: 86400000,
            secure: isProduction,
            sameSite:isProduction?"none":"lax"
        }
        // Le token n'est plus trace : c'est une credentielle de session.
        res.cookie(name, value, { ...defaultOptions, ...options })
    }

    async loginController(req: Request, res: Response) {
        try {
            const { email, password } = req.body
            // Le couple email/mot de passe etait journalise en clair a chaque tentative.

            if (!email || !password) throw new AppError("Missing required fields email and password", 400)
            const actorEmail = String(email).trim().toLowerCase().slice(0, 255)
            const result = await this.authService.login({ email, password }).catch(async (error: unknown) => {
                await recordAudit(req, {
                    action: "client.login_failed",
                    actorEmail,
                    details: { reason: error instanceof AppError ? error.message : "server_error" }
                })
                throw error
            })
            const client = await prisma.user.findUnique({ where: { email: actorEmail }, select: { user_id: true } })
            await recordAudit(req, { action: "client.login", actorEmail, targetId: client?.user_id ?? null })
            AuthControllers.setCookie(res, config.cookie_jwt_name || "AUTH_TOKEN", result.token)
           
            res.status(200).json({
                success: true,
                message: "connexion réussie",
                data: result.user_session,
                token:result.token
            })
        } catch (error: unknown) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            console.error(error);
            return res.status(500).json({
                success: false,
                message: "Erreur serveur lors de la connexion"
            });
        }
    }


    /** Efface le cookie de session et trace la déconnexion. */
    async logoutController(req: Request, res: Response) {
        await recordAudit(req, { action: "client.logout", targetId: req.user?.user_id ?? null })
        res.clearCookie(config.cookie_jwt_name || "AUTH_TOKEN")
        res.status(200).json({ success: true })
    }

    async verifyCurrentUser(req: Request, res: Response) {
        try {
            const user = await this.authService.getCurrentUser(req.user)

            res.status(200).json({
                success: true,
                data: user
            })

        } catch (error: any) {
            res.status(401).json({
                success: false,
                message: error.message
            })
        }
    }
}