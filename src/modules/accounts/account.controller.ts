import { Accountservice } from "./account.service.js";
import { Request, Response } from "express";
import { AppError } from "@/utils/errorHandler.js";

export class AccountControllers {

    private accountService;

    constructor() {
        this.accountService = new Accountservice();
        this.depositController = this.depositController.bind(this)
        this.getUserBalance=this.getUserBalance.bind(this)
    }

    async depositController(req: Request, res: Response) {
        try {
            const { amount } = req.body;
            const { user_id } = req.user ?? {}

            if (!amount || isNaN(amount)) {
                throw new AppError("Le montant est requis et doit être un nombre", 400);
            }
            if (!user_id) {
                throw new AppError("user_id requis", 400);
            }

            const result = await this.accountService.deposit(Number(amount), user_id);


            return res.status(200).json({
                success: true,
                message: "Dépôt effectué avec succès",
                data: result.data
            });

        } catch (error: any) {

            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            console.error(error);
            return res.status(500).json({
                success: false,
                message: "Erreur serveur lors du dépôt"
            });
        }
    }

    /**
     * SÉCURITÉ — correctif du 2026-08-31.
     *
     * `user_id` était lu depuis `req.body`. N'importe quel utilisateur
     * authentifié pouvait donc consulter le solde et les positions de
     * n'importe quel autre en envoyant son identifiant dans le corps de la
     * requête — référence directe d'objet non sécurisée (IDOR).
     *
     * L'identité provient désormais exclusivement du token vérifié.
     */
    async getUserBalance(req: Request, res: Response) {
        try {
            const user_id = req.user?.user_id

            if (!user_id) {
                throw new AppError("Authentification requise", 401)
            }

            const result = await this.accountService.getBalance(user_id)
            return res.status(200).json({
                success: true,
                data: result
            })

        } catch (error: any) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            return res.status(500).json({
                success: false,
                message: "Erreur serveur lors de la récupération de la balance"
            });
        }
    }
}