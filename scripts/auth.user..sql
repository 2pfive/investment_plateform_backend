-- SCHEMA: auth

-- DROP SCHEMA IF EXISTS auth ;
SELECT CURRENT_DATABASE();
SET SEARCH_PATH='auth';

DROP TABLE IF EXISTS "user";
CREATE TABLE "user"(
"_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
"user_id" UUID NOT NULL DEFAULT GEN_RANDOM_UUID(),
"phone_number" VARCHAR(15) NOT NULL,
"birth_date" DATE NOT NULL CHECK (birth_date<=current_date - INTERVAL '18 years'), 
"email"  TEXT NOT NULL,
"password" TEXT NOT NULL,
"is_active" BOOLEAN DEFAULT TRUE,
"created_at" TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION check_user_age()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.birth_date > CURRENT_DATE - INTERVAL '18 years' THEN
		RAISE EXCEPTION 'Utilisateur doit avoir au moins 18 ans. Date de naissance invalide: %', NEW.birth_date;
	END IF;
END;
$$ LANGUAGE plpgsql;

SET SEARCH_PATH='auth';
CREATE TRIGGER trg_check_age
BEFORE INSERT OR UPDATE ON auth.user
FOR EACH ROW
EXECUTE FUNCTION check_user_age();


ALTER TABLE auth.user ADD CONSTRAINT unique__user_uuid UNIQUE (user_id)