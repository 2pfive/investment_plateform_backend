import { AppError } from "@/utils/errorHandler.js"
import { AuthService } from "./auth.service.js"
import { Response, Request } from "express"

export class AuthControllers {
    private authService
    constructor() {
        this.authService = new AuthService()
        this.loginController=this.loginController.bind(this)
    }

    async loginController(req: Request, res: Response) {
        try {
            const { email, password } = req.body
            console.log("login id",email,password);
            
            if (!email || !password) throw new AppError("Missing required fields email and password", 400)
            const result = await this.authService.login({ email, password })
            res.status(200).json({
                success: true,
                message: "connexion réussie",
                data: result.user_session
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

}