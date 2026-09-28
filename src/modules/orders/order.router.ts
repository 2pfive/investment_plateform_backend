import { Router } from "express";
import { tradingLimiter } from "@/middlewares/rate.limiter.middlewares.js";
import { OrderController } from "./order.controller.js";

/** Monté derrière `requireAuth` : toutes les routes exigent une session. */
const router = Router();
const controller = new OrderController();

// Borne les rejeux. Ne remplace pas l'idempotence, qui reste la vraie
// protection contre le double envoi.
router.post("/", tradingLimiter, controller.place);
router.post("/estimate", controller.estimate);
router.get("/", controller.list);
router.get("/:id", controller.get);

export default router;
