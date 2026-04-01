import MarcketService from "./market.service.js"
import { AppError } from "@/utils/errorHandler.js";
import { Response, Request } from "express";
export default class MarketControllers {
    private marketService

    constructor() {
        this.marketService = new MarcketService()
        this.getETFs = this.getETFs.bind(this)
        this.getAllQuotes=this.getAllQuotes.bind(this)
        this.getEtfDetails=this.getEtfDetails.bind(this)
    }

    async getETFs(req: Request, res: Response) {
        try {
            const result = await this.marketService.getAll()
            res.status(200).json({
                success: true,
                status: 200,
                data: result
            })
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
            })
        }
    }

    async getAllQuotes(req: Request, res: Response) {
        try {
            const result = await this.marketService.getAllQuotes()
            res.status(200).json({
                success: true,
                status: 200,
                data: result
            })
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
            })
        }
    }

    async getEtfDetails(req: Request, res: Response) {
        try {
            const { etf_id } = req.params

            if (!etf_id) {
                throw new AppError("etf_id requis", 400)
            }

            const result = await this.marketService.getDetailsByEtfId(etf_id as string)

            res.status(200).json({
                success: true,
                status: 200,
                data: result
            })
        } catch (error: any) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }

            console.log(error)
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            })
        }
    }

}