import { brokerConfig } from "@/config/broker.config.js";
import { ordersConfig } from "@/config/orders.config.js";
import { OrderService } from "@/modules/orders/order.service.js";

/**
 * ============================================================
 * SYNCHRONISATION DES ORDRES EN COURS
 * ============================================================
 *
 * Relit périodiquement chez le courtier les ordres non terminés : passage de
 * « accepté » à « exécuté », exécutions partielles, expirations, et levée du
 * doute sur les ordres dont la transmission a été interrompue.
 *
 * Interrogation plutôt que flux `trade_updates` pour cette première version :
 * l'authentification OAuth du flux est contradictoire dans la documentation
 * d'Alpaca et doit être testée en paper. Le flux viendra en complément, pas
 * en remplacement — cette boucle reste le filet qui rattrape un message
 * manqué ou une connexion WebSocket tombée.
 *
 * Un seul passage à la fois : si un passage dépasse l'intervalle, le suivant
 * est sauté plutôt qu'empilé.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startOrderSyncWorker(): void {
  const settings = ordersConfig();

  if (!settings.syncEnabled) {
    console.log("[order-sync] désactivé (ORDER_SYNC_ENABLED=false)");
    return;
  }

  if (!brokerConfig().ok) {
    console.log("[order-sync] courtier non configuré : worker non démarré");
    return;
  }

  if (timer) return;

  const service = new OrderService();

  timer = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      const { checked, failed } = await service.syncPending();
      if (failed > 0) {
        console.warn(`[order-sync] ${failed}/${checked} ordre(s) non synchronisé(s)`);
      }
    } catch (error) {
      console.error("[order-sync] passage en échec :", (error as Error)?.name || "erreur");
    } finally {
      running = false;
    }
  }, settings.syncIntervalSeconds * 1000);

  // Ne retient pas le processus à l'arrêt.
  timer.unref();

  console.log(`[order-sync] démarré, toutes les ${settings.syncIntervalSeconds} s`);
}

export function stopOrderSyncWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
