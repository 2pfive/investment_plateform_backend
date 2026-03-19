import { Router } from "express";
import userRouter from "../modules/user/user.router.js"
import investingRouter from "../modules/investing/investing.router.js"
import BillingRouter from "../modules/accounts/account.router.js"
import AuthRouter from "../modules/auth/auth.router.js"
import { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import YahooFinance from "yahoo-finance2/src/index.ts";


const router=Router()

router.use('/users',userRouter)
router.use("/investing",investingRouter)
router.use("/billing",BillingRouter)
router.use('/auth',AuthRouter)

router.get('/etf', async (req: Request, res: Response) => {
    try {
        console.log("TEST PRISMA START");

        const etf = await prisma.exchange_traded_fund.findMany({
            take: 10
        });

        console.log("RESULT", etf);

        res.json(etf);

    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});


router.get('/quote-history',async(req:Request,res:Response)=>{
    try {
    const yf=new YahooFinance()
    const response=await yf.quote("SPY")
    res.status(200).json(response)

    } catch (error) {
        console.error(error);
        res.status(500).json(error);
    }
})
export default router;