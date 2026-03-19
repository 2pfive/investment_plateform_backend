import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import compression from "compression";
import http from "http"
import cors from "cors";
import morgan from "morgan"
import dotenv from "dotenv";
import { config } from "./config/env.js";
import router from "./router/index.js";
import { initWebSocket } from "lib/websocket.js";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

const app=express()
const server=http.createServer(app)

app.use(cors(config.corsOptions))

app.use(express.json())

app.use(compression())
app.use(cookieParser())
app.use(bodyParser.json())

app.use('/api/v1',router)

initWebSocket(server)

app.get('/health',(req,res)=>{
  res.status(200).json({message:'OK',timestamp:new Date().toISOString()})
})

server.listen(config.port,()=>{
    console.log('serveur lancé sur le port',"http://localhost:"+config.port);
    console.log(process.env.ORIGINS);
    console.log(config);
    
})
