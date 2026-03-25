import dotenv from "dotenv";

dotenv.config({
    path: `.env.${process.env.NODE_ENV || "development"}`
});


const origins = process.env.ORIGINS?.split(",").map(o => o.trim()) || [
    "http://localhost:5173"
];


const corsOptions = {
    origin: function (origin: string | undefined, callback: Function) {
        if (!origin) return callback(null, true);
        
        if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
            return callback(null, true);
        }

        if (origins.includes(origin)) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS","PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Range", "X-Total-Count"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 600
}

export const config = {
    corsOptions: corsOptions,
    port: process.env.PORT || 3300,
    saltRounds: process.env.SALT_ROUNDS || 10,
    cookie_jwt_name:process.env.COOKIE_JWT_NAME,
    exchange_rate_url:`${process.env.EXCHANGE_RATE_URL}${process.env.EXCHANGE_RATE_API_KEY}`,

}