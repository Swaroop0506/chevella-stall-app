-- Back of the card as a first-class citizen.
--
-- On Indian B2B cards the back is rarely decorative: it carries the office address, the
-- product list, branch numbers and sometimes the GSTIN. Reading only the front throws
-- that away, and the front often has no address at all.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS card_back_thumb_path VARCHAR(300);

-- Kept separate from ocr_raw_text so the admin can show which side a value came from,
-- and so re-running OCR on one side never clobbers the other.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ocr_back_text       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ocr_back_confidence NUMERIC(5,4);

-- Which fields the back supplied, e.g. {"address": true, "gstin": true}. Lets the review
-- screen explain itself instead of a value appearing from nowhere.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS back_filled_fields  JSONB;

-- The full-text index is rebuilt to cover the back as well, otherwise searching for a
-- company's street or a product printed only on the reverse finds nothing.
DROP INDEX IF EXISTS idx_leads_fts;

CREATE INDEX idx_leads_fts ON leads
USING GIN (to_tsvector('simple',
    coalesce(full_name,'')  || ' ' || coalesce(company,'')  || ' ' ||
    coalesce(email,'')      || ' ' || coalesce(phone_primary,'') || ' ' ||
    coalesce(city,'')       || ' ' || coalesce(ocr_raw_text,'') || ' ' ||
    coalesce(ocr_back_text,'')));
