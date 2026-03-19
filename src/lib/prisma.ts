import { PrismaClient } from "@prisma/client"
import { Pool } from "pg"
import { PrismaPg } from "@prisma/adapter-pg"
import dotenv from "dotenv";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
})

const globalForPrisma = global as unknown as {
  prisma: PrismaClient | undefined
}

console.log("DATABASE URL",process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

const adapter = new PrismaPg(pool)

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: ["error", "warn"]
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
} 