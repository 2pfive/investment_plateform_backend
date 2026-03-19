export interface PortfolioPosition {
    etf_id: string;
    symbol: string;
    quantity: number;
    avg_buy_price: number;
    current_price?: number;
}