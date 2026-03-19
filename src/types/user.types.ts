export interface UserPublic {
    email: string;
    phone_number: string;
    birth_date:Date,
    created_at?: Date;
}

export interface UserSession{
    account:{
        balance: number,
        currency: string,
        user: UserPublic
     } [],
    positions: {
        quantity: number,
        avg_buy_price: number,
        exchange_traded_fund: {
            id: string,
            symbol: string,
            name: string,
            currency: string,
            category: string,
            region: string,
            risk_level: string,
            expense_ratio: number,
            inception_date: Date,
            dividend_yield: number
        }
    }[]
}