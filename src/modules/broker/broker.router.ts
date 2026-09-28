import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.middlewares.js";
import { tradingLimiter } from "@/middlewares/rate.limiter.middlewares.js";
import { BrokerController } from "./broker.controller.js";

const router = Router();
const controller = new BrokerController();

/*
 * Le rappel est la seule route publique : le navigateur qui revient d'Alpaca
 * ne porte pas de session AMARA. Il est authentifié par le `state`, à usage
 * unique, émis pour un utilisateur précis.
 */
router.get("/alpaca/callback", controller.callback);

// Chaque ouverture crée une ligne en base : bornée comme une opération sensible.
router.post("/alpaca/authorize", requireAuth, tradingLimiter, controller.authorize);

router.get("/connection", requireAuth, controller.getConnection);
router.delete("/connection", requireAuth, controller.disconnect);

export default router;
