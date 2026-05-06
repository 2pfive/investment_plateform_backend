export interface CreateUserDTO {
    email: string;
    password: string;
    phone_number: string;
    birth_date: Date;
    first_name?:string;
    last_name?:string;
}