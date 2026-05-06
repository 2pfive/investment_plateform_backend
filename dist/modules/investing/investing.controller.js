import { InvestingService } from "./investing.service.js";
import { AppError } from "../../utils/errorHandler.js";
export class InvestingController {
    investService;
    constructor() {
        this.investService = new InvestingService();
        this.Invest = this.Invest.bind(this);
    }
    Invest = async (req, res, next) => {
        try {
            const { amount_to_invest, etf_id } = req.body;
            const { user_id } = req.user ?? {};
            if (!user_id) {
                throw new AppError("user_id requis", 400);
            }
            const result = await this.investService.investByAmount({ user_id, etf_id, amount_to_invest });
            res.status(201).json({
                success: true,
                status: 201,
                ...result
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
    };
    GetperFormancePortfolio = async (req, res) => {
        try {
            // const { id } = req.params
            const { portfolio_id } = req.user ?? {};
            if (!portfolio_id) {
                throw new AppError("portfolio_id requis", 400);
            }
            const result = await this.investService.getAllPerformances(portfolio_id);
            res.status(201).json({
                success: true,
                status: 201,
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
    };
}
//# sourceMappingURL=investing.controller.js.map