import { Router } from "express";
import { InvestingController } from "./investing.controller.js";


const router=Router()
const controller=new InvestingController()

router.post("/",controller.Invest)
router.get("/performances/:id",controller.GetperFormancePortfolio)

export default router

