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
            const {user_id}=req.user

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

    async getUserBalance(req: Request, res: Response) {
        try {
            const { user_id } = req.body
            const result = await this.accountService.getBalance(user_id)
            res.status(200).json({
                success: true,
                data: result
            })

        } catch (error: any) {
            console.log(error);
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