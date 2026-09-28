import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { config } from "./config/env.js";
import router from "./router/index.js";
import { apiLimiter } from "./middlewares/rate.limiter.middlewares.js";
import { initWebSocket } from "lib/websocket.js";
import { startOrderSyncWorker } from "./workers/broker-order-sync.worker.js";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

const app = express();
const server = http.createServer(app);

/**
 * Helmet était installé mais jamais monté. Il pose notamment
 * X-Content-Type-Options, Referrer-Policy et HSTS.
 *
 * `contentSecurityPolicy` est désactivé : cette application ne sert que du
 * JSON, la CSP n'a rien à protéger ici et gênerait un futur Swagger UI.
 */
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors(config.corsOptions));
app.set("trust proxy", 1);

app.use(express.json({ limit: "100kb" }));
app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json({ limit: "100kb" }));

/** Garde-fou général. Les limites strictes sont posées route par route. */
app.use("/api/v1", apiLimiter, router);

initWebSocket(server);

app.get("/health", (_req, res) => {
  res.status(200).json({ message: "OK", timestamp: new Date().toISOString() });
});

/**
 * `config.port` est désormais typé `number` (voir config/env.ts) : la surcharge
 * `listen(port, host, cb)` est correctement résolue. L'ancienne version passait
 * un `string | number` et ne compilait pas.
 */
server.listen(config.port, "0.0.0.0", () => {
  console.log(`Serveur démarré sur http://localhost:${config.port}`);
  console.log(`Environnement : ${process.env.NODE_ENV || "development"}`);
  console.log(`Origines CORS autorisées : ${config.origins.join(", ") || "(aucune)"}`);

  // Sans configuration Alpaca, le worker ne démarre pas : le reste de l'API
  // fonctionne normalement.
  startOrderSyncWorker();
  // L'objet `config` complet n'est plus journalisé : il transportait des
  // valeurs dérivées de secrets, dont l'URL du service de taux avec sa clé API.
});
