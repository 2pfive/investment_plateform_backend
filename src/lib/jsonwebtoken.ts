import jwt from "jsonwebtoken"
import crypto from "crypto"
import { readFileSync } from "fs"
import dotenv from "dotenv"
dotenv.config({
    path:`.env.${process.env.NODE_ENV || "development"}`
})

export const generateToken = async (payload:any) => {

    const passphrase = process.env.PASSPHRASE
    console.log(passphrase);
    
    const encryptedKey = readFileSync('./src/config/session_user_key_private.pem')
    console.log(encryptedKey);
    
    const privateKey = crypto.createPrivateKey({
      key: encryptedKey,
      format: 'pem',
      passphrase: passphrase
    })
  
    const token = jwt.sign({ payload }, privateKey, { algorithm: 'RS256', expiresIn: Math.floor(Date.now() / 1000) + (24 * 60 * 60) })
  
    return token
}
  
 
