import { Router } from "express";
import { AccountControllers } from "./account.controller.js";
const router = Router();
const controller = new AccountControllers();
router.patch("/account/deposit", controller.depositController);
router.get('/account', controller.getUserBalance);
export default router;
//# sourceMappingURL=account.router.js.map