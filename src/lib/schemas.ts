import { z } from "zod";

export const CreateUserSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  phone_number: z.string().min(8).max(15),
  birth_date: z.string().transform((val) => new Date(val))
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;