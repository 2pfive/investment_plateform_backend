import MarcketService from "./market.service.js"


export default class MarketControllers{
    private marketService
    constructor(){
        this.marketService=new MarcketService()
    }
    
}