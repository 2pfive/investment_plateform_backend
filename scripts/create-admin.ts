/**
 * Crée (ou réinitialise) un compte du back-office. Sert à amorcer le premier
 * SUPER_ADMIN ; les suivants se créent depuis l'interface d'administration.
 *
 *   npm run admin:create -- <email> "<nom>" <mot de passe> [SUPER_ADMIN|ADMIN|FINANCE|SUPPORT]
 */
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/utils/utils.js";
import type { AdminRole } from "@prisma/client";

const [email, name, password, role = "SUPER_ADMIN"] = process.argv.slice(2);

async function main() {
  if (!email || !name || !password) throw new Error('Usage : npm run admin:create -- <email> "<nom>" <mot de passe> [rôle]');
  if (password.length < 12) throw new Error("Mot de passe : 12 caractères minimum.");
  if (!["SUPER_ADMIN", "ADMIN", "FINANCE", "SUPPORT"].includes(role)) throw new Error("Rôle inconnu.");
  const data = { name, password: await hashPassword(password), role: role as AdminRole, isActive: true };
  await prisma.adminUser.upsert({ where: { email: email.toLowerCase() }, create: { email: email.toLowerCase(), ...data }, update: data });
  console.log(`Administrateur ${email} prêt (${role}).`);
}

main()
  .catch((e) => {
    console.error(`Échec : ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
