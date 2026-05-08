import jwt from "jsonwebtoken"
import { readFileSync } from "fs"
import { Request, Response, NextFunction } from "express";
import { config } from "@/config/env.js";

export const requireAuth = (req:Request, res:Response, next:NextFunction) => {

    const token = req.cookies[`${config.cookie_jwt_name}`];
    console.log("################### TOKEN #############",token);
    
    if (!token) {
        console.log("################### TOKEN INVALIDE OU MANQUANT #############");
        return res.status(401).json({ error: 'Token manquant ou invalide' });
    }

    const publicKey = readFileSync('./src/config/session_user_key_public.pem', 'utf-8');

    jwt.verify(token, publicKey, (err:any, decoded:any) => {
        if (err) {
            return res.status(401).json({ error: 'Token invalide' });
        }
        // console.log(decoded);

        req.user = decoded.payload;
        next();
    });
};