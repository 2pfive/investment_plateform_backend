import { Router } from "express";
import { AuthControllers } from "./auth.controller.js";
import { usersControllers } from "../user/user.controller.js";
import { requireAuth } from "../../middlewares/auth.middlewares.js";
import {
  authLimiter,
  registerLimiter
} from "../../middlewares/rate.limiter.middlewares.js";

const router = Router()
const controller = new AuthControllers()
const user_controller = new usersControllers()

// Ces deux routes n'avaient aucune limitation : /login acceptait un nombre
// illimité de tentatives, ce qui rendait le brute force trivial.
router.post('/login', authLimiter, controller.loginController)
router.post('/register', registerLimiter, user_controller.createUser)

router.get('/me', requireAuth, controller.verifyCurrentUser)

export default router
