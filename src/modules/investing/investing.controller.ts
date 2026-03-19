import { InvestingService } from "./investing.service.js"
import { Response, Request, NextFunction } from "express"
import { AppError } from "@/utils/errorHandler.js"

export class InvestingController {

    private investService

    constructor() {
        this.investService = new InvestingService()
        this.Invest = this.Invest.bind(this)
    }

    public Invest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { user_id, amount_to_invest, etf_id } = req.body
            const result = await this.investService.investByAmount({ user_id, etf_id, amount_to_invest })
            res.status(201).json({
                success: true,
                status: 201,
                data: result
            });

        } catch (error: any) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            console.log(error)
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }

    public GetperFormancePortfolio = async (req: Request, res: Response) => {
        try {
            const { id } = req.params
            const result = await this.investService.getAllPerformances(id)
            res.status(201).json({
                success: true,
                status: 201,
                data: result
            });
        } catch (error: any) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            console.log(error)
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }

}
