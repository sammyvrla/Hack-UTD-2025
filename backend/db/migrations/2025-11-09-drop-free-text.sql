-- Drop obsolete short-answer text column after survey simplification
ALTER TABLE customer_surveys
  DROP COLUMN IF EXISTS free_text;