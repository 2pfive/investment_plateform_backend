-- Adresse de retour dans l'application mobile, validée contre une liste
-- blanche à la création du state. Colonne nullable : purement additive, sans
-- effet sur les lignes existantes ni sur le frontend web.
ALTER TABLE "investing"."oauth_states" ADD COLUMN "return_url" VARCHAR(512);
