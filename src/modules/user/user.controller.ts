import { UserService } from "./user.service.js";


export class usersControllers {
    private userservice

    constructor() {
        this.userservice = new UserService()
        this.createUser = this.createUser.bind(this);
    }

    async createUser(req: Request, res: Response) {
        try {
            const { email, password, birth_date, phone_number } = req.body

            const result = await this.userservice.create({
                email,
                password,
                birth_date,
                phone_number
            })

            res.status(201).json({
                success: true,
                status:201,
                data: result
            });

        } catch (error:any) {
            res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }
}
