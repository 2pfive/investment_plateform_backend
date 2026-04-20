import { Router } from "express";
import { AuthControllers } from "./auth.controller.js";
import { usersControllers } from "../user/user.controller.js";
import { requireAuth } from "../../middlewares/auth.middlewares.js";

const router = Router()
const controller = new AuthControllers()
const user_controller = new usersControllers()

router.post('/login', controller.loginController)
router.post('/register', user_controller.createUser)
router.get('/me', requireAuth, controller.verifyCurrentUser)
export default router