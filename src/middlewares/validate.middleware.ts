import { Request, Response, NextFunction } from "express";
import { ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>) {

  return (req: Request, res: Response, next: NextFunction) => {

    try {

      const parsed = schema.parse(req.body);
      req.body = parsed;
      next();

    } catch (error: any) {

      return res.status(400).json({
        success: false,
        errors: error.errors
      });
    }
  };
}