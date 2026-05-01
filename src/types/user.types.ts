export interface UserPublic {
    email: string;
    phone_number: string;
    birth_date:Date,
    created_at?: Date | null;
}

export interface UserSession{
    account:{
        balance: number,
        currency: string | null,
        user: UserPublic,
        exchangeRate?:number
     } ,
    positions: {
        quantity: number,
        avg_buy_price: number,
        exchange_traded_fund: {
            id: string,
            symbol: string,
            name: string,
            currency: string,
            category: string | null,
            region: string | null,
            risk_level: string | null,
            expense_ratio: number | null,
            inception_date: Date | null,
            dividend_yield: number | null
        }
    }[]
}