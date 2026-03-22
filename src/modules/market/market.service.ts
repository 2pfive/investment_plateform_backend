import { prisma } from "@/lib/prisma.js";
import { AppError } from "@/utils/errorHandler.js";


class MarcketService {

    getAll(){
        const etfs=prisma.exchange_traded_fund.findMany()
        if(!etfs) throw new AppError("etfs not found",404)
            
            return etfs
    }
}


export default MarcketService