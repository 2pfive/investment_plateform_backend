import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { config } from "../config/env.js";
export const requireAuth = (req, res, next) => {
    const token = req.cookies[`${config.cookie_jwt_name}`];
    if (!token) {
        return res.status(401).json({ error: 'Token manquant ou invalide' });
    }
    const publicKey = readFileSync('./src/config/session_user_key_public.pem', 'utf-8');
    jwt.verify(token, publicKey, (err, decoded) => {
        if (err) {
            return res.status(401).json({ error: 'Token invalide' });
        }
        // console.log(decoded);
        req.user = decoded.payload;
        next();
    });
};
//# sourceMappingURL=auth.middlewares.js.map