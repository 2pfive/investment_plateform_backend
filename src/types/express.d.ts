import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        user_id?: string;
        account_id?: string;
        portfolio_id?: string;
        [key: string]: unknown;
      };
    }
  }
}

export {};
import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        user_id?: string;
        account_id?: string;
        portfolio_id?: string;
        [key: string]: unknown;
      };
    }
  }
}

export {};
