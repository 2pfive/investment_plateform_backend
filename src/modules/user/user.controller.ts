import { UserService } from "./user.service.js";
import { Request, Response } from "express";

export class usersControllers {
    private userservice

    constructor() {
        this.userservice = new UserService()
        this.createUser = this.createUser.bind(this);
    }

    async createUser(req: Request, res: Response) {
        try {
            const { email, password, birth_date, phone_number, first_name, last_name } = req.body

            const result = await this.userservice.create({
                email,
                password,
                birth_date,
                phone_number,
                last_name,
                first_name
            })

            res.status(201).json({
                success: true,
                status: 201,
                data: result
            });

        } catch (error: any) {
            res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }
}
