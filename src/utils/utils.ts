import bcrypt from "bcrypt"
import { config } from "config/env.js"
import axios from "axios"

export const hashPassword = async (pswd: string) => {
  const hashed = await bcrypt.hash(pswd, config.saltRounds)
  return hashed
}

export const comparePasswords = async (hashed_pswd: string, plain_pwsd: string) => {
  const is_same = await bcrypt.compare(plain_pwsd, hashed_pswd)
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

export async function getXafToUsdRate(): Promise<number> {
  const res = await axios.get(`${config.exchange_rate_url}/latest/USD`);
  const data = res.data;

  if (data?.result !== 'success') {
    console.log("Impossible de récupérer le taux de change");
    return 1 / 565.6368;
  }

  const usdToXaf = data.conversion_rates['XAF'];

  return 1 / usdToXaf;
}

export function normalizeQuote(quote: any) {
  return {
      ...quote,
      ytd: quote.ytd != null ? +(quote.ytd * 100).toFixed(2) : null,
      changePercent: quote.changePercent != null ? +(quote.changePercent * 100).toFixed(2) : null
  };
}