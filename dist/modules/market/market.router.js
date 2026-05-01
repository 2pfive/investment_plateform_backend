import { Router } from "express";
import MarketControllers from "./market.controller.js";
const router = Router();
const controller = new MarketControllers();
router.get('/etfs', controller.getETFs);
router.get('/quotes', controller.getAllQuotes);
router.get('/etf/:etf_id/details', controller.getEtfDetails);
router.get("/etfs/:id/performance", controller.getEtfPerformance);
export default router;
//# sourceMappingURL=market.router.js.map