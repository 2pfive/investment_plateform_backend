import jwt from "jsonwebtoken"
import { readFileSync } from "fs"
import { Request, Response, NextFunction } from "express";

export const requireAuth = (req:Request, res:Response, next:NextFunction) => {

    const token = req.cookies.OARH_AUTH;

    if (!token) {
        return res.status(401).json({ error: 'Token manquant ou invalide' });
    }

    const publicKey = readFileSync('./config/session_user_key_public.pem', 'utf-8');

    jwt.verify(token, publicKey, (err:any, decoded:any) => {
        if (err) {
            return res.status(401).json({ error: 'Token invalide' });
        }
        // console.log(decoded);

        req.user = decoded.payload;
        next();
    });
};