import { UserService } from "./user.service.js";
export class usersControllers {
    userservice;
    constructor() {
        this.userservice = new UserService();
        this.createUser = this.createUser.bind(this);
    }
    async createUser(req, res) {
        try {
            const { email, password, birth_date, phone_number, first_name, last_name } = req.body;
            const result = await this.userservice.create({
                email,
                password,
                birth_date,
                phone_number,
                last_name,
                first_name
            });
            res.status(201).json({
                success: true,
                status: 201,
                data: result
            });
        }
        catch (error) {
            res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }
}
//# sourceMappingURL=user.controller.js.map