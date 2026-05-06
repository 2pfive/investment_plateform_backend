import MarcketService from "./market.service.js";
import { AppError } from "../../utils/errorHandler.js";
export default class MarketControllers {
    marketService;
    constructor() {
        this.marketService = new MarcketService();
        this.getETFs = this.getETFs.bind(this);
        this.getAllQuotes = this.getAllQuotes.bind(this);
        this.getEtfDetails = this.getEtfDetails.bind(this);
        this.getEtfPerformance = this.getEtfPerformance.bind(this);
    }
    async getETFs(req, res) {
        try {
            const result = await this.marketService.getAll();
            res.status(200).json({
                success: true,
                status: 200,
                data: result
            });
        }
        catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }
            console.log(error);
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }
    async getAllQuotes(req, res) {
        try {
            const result = await this.marketService.getAllQuotes();
            res.status(200).json({
                success: true,
                status: 200,
                data: result
            });
        }
        catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }
            console.log(error);
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }
    async getEtfDetails(req, res) {
        try {
            const { etf_id } = req.params;
            if (!etf_id) {
                throw new AppError("etf_id requis", 400);
            }
            const result = await this.marketService.getDetailsByEtfId(etf_id);
            res.status(200).json({
                success: true,
                status: 200,
                data: result
            });
        }
        catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }
            console.log(error);
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }
    async getEtfPerformance(req, res) {
        try {
            const { id } = req.params;
            const { period } = req.query;
            const result = await this.marketService.getEtfPerformance(id, period);
            res.status(200).json({
                success: true,
                data: result
            });
        }
        catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message
                });
            }
            res.status(500).json({
                success: false,
                message: error?.message || "Erreur interne serveur"
            });
        }
    }
}
//# sourceMappingURL=market.controller.js.map