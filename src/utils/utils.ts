import bcrypt from "bcrypt"
import { config } from "config/env.js"
import { string } from "zod"

export const hashPassword=async(pswd:string)=>{
    const hashed=await bcrypt.hash(pswd,config.saltRounds)
    return hashed
}

export const comparePasswords=async(hashed_pswd:string,plain_pwsd:string)=>{
  const is_same=await bcrypt.compare(plain_pwsd,hashed_pswd)
  return is_same
}


export function generateTimestamps(
    start: number,
    end: number,
    intervalMs: number
  ) {
    const timestamps = []
  
    for (let t = start; t <= end; t += intervalMs) {
      timestamps.push(t)
    }
  
    return timestamps
}