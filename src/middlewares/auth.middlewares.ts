import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { Request, Response, NextFunction } from "express";
import { config } from "@/config/env.js";

const publicKey = readFileSync(
  "./src/config/session_user_key_public.pem",
  "utf-8"
);

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  let token: string | undefined;

  // 1. Cookie
  token = req.cookies?.[`${config.cookie_jwt_name}`];

  // 2. Authorization header fallback
  if (!token) {

    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
  }

  console.log("################### TOKEN #############");
  console.log(token);

  if (!token) {
    console.log(
      "################### TOKEN INVALIDE OU MANQUANT #############"
    );

    return res.status(401).json({
      success: false,
      error: "Token manquant ou invalide"
    });
  }

  jwt.verify(token, publicKey, (err: any, decoded: any) => {

    if (err) {

      console.log("JWT VERIFY ERROR", err);

      return res.status(401).json({
        success: false,
        error: "Token invalide"
      });
    }

    req.user = decoded.payload;

    next();
  });
};