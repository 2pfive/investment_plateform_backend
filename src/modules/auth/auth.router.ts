import { Router } from "express";
import { AuthControllers } from "./auth.controller.js";

const router=Router()
const controller=new AuthControllers()

router.post('/login',controller.loginController)


export default router