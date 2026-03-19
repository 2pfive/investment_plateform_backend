-- SCHEMA: billing

-- DROP SCHEMA IF EXISTS billing ;

SET SEARCH_PATH="billing";

CREATE TABLE accounts(
 "id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
 "user_id" UUID REFERENCES auth.user("user_id"),
 "balance" NUMERIC(12,4) DEFAULT 0,
 created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TYPE transaction_type AS ENUM('buy','sell');

CREATE TABLE transactions(
"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
"account_id" UUID REFERENCES billing.accounts("id"),
"amount" NUMERIC(12,4) NOT NULL CHECK(amount IS NOT NULL OR amount >0),
"type" transaction_type NOT NULL DEFAULT 'buy',
"created_at" TIMESTAMPTZ DEFAULT NOW()
)