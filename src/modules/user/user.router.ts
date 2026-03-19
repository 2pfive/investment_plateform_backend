import { Router } from "express";
import { usersControllers } from "./user.controller.js";

const router=Router()
const controller=new usersControllers()

router.post('/',controller.createUser)

export default router