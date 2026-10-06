-- Chevella Farms Stall App — initial schema
-- All timestamps stored UTC (TIMESTAMPTZ), rendered in Asia/Kolkata by the clients.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============ ADMINS ============
CREATE TABLE IF NOT EXISTS admins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120)  NOT NULL,
    email           VARCHAR(160)  UNIQUE NOT NULL,
    password_hash   TEXT          NOT NULL,
    is_active       BOOLEAN       NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ============ EVENTS ============
CREATE TABLE IF NOT EXISTS events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(160)  NOT NULL,
    slug            VARCHAR(90)   UNIQUE NOT NULL,
    venue           VARCHAR(200),
    stall_no        VARCHAR(60),
    city            VARCHAR(120),
    start_date      DATE,
    end_date        DATE,
    status          VARCHAR(20)   NOT NULL DEFAULT 'upcoming'
                      CHECK (status IN ('upcoming','active','completed','archived')),
    website_url     VARCHAR(300)  NOT NULL DEFAULT 'https://www.chevellafarms.com/',
    notes           TEXT,
    created_by      UUID REFERENCES admins(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- ============ EVENT CONTACTS (one QR per person) ============
CREATE TABLE IF NOT EXISTS event_contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    -- short, URL-safe, globally unique code used in /c/:code and in the QR payload
    code            VARCHAR(16)   UNIQUE NOT NULL,

    name            VARCHAR(120)  NOT NULL,
    designation     VARCHAR(120),
    company         VARCHAR(160)  NOT NULL DEFAULT 'Chevella Farms',
    phone_e164      VARCHAR(20)   NOT NULL,          -- +919701221934
    whatsapp_e164   VARCHAR(20),                     -- defaults to phone_e164 when null
    email           VARCHAR(160),
    website_url     VARCHAR(300),
    address         TEXT,
    wa_prefill      TEXT,                            -- pre-typed WhatsApp message
    sort_order      INTEGER       NOT NULL DEFAULT 0,
    is_active       BOOLEAN       NOT NULL DEFAULT true,

    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_event ON event_contacts(event_id, sort_order);

-- ============ CONTACT SCANS (QR analytics) ============
CREATE TABLE IF NOT EXISTS contact_scans (
    id              BIGSERIAL PRIMARY KEY,
    contact_id      UUID NOT NULL REFERENCES event_contacts(id) ON DELETE CASCADE,
    action          VARCHAR(16) NOT NULL CHECK (action IN ('view','vcard','whatsapp','call','website')),
    user_agent      VARCHAR(400),
    ip_hash         CHAR(64),                        -- sha256(ip + salt); raw IP is never stored
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scans_contact ON contact_scans(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_action  ON contact_scans(action);

-- ============ LEADS (scanned visiting cards) ============
CREATE TABLE IF NOT EXISTS leads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    -- idempotency key generated on the phone, so an offline retry never double-inserts
    client_capture_id VARCHAR(64) UNIQUE,

    captured_by       VARCHAR(120),                  -- free-text staff name, no login required
    device_label      VARCHAR(120),
    captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    card_image_path   VARCHAR(300),
    card_thumb_path   VARCHAR(300),
    card_back_path    VARCHAR(300),

    -- OCR provenance
    ocr_engine        VARCHAR(40),
    ocr_version       VARCHAR(20),
    ocr_raw_text      TEXT,
    ocr_blocks        JSONB,                         -- [{text, box, score}]
    ocr_confidence    NUMERIC(5,4),
    ocr_ms            INTEGER,

    -- parsed / corrected fields
    full_name         VARCHAR(160),
    designation       VARCHAR(160),
    company           VARCHAR(200),
    phone_primary     VARCHAR(20),
    phone_secondary   VARCHAR(20),
    whatsapp          VARCHAR(20),
    email             VARCHAR(160),
    email_secondary   VARCHAR(160),
    website           VARCHAR(300),
    address           TEXT,
    city              VARCHAR(120),
    state             VARCHAR(120),
    pincode           VARCHAR(12),
    gstin             VARCHAR(20),

    field_confidence  JSONB,                         -- {full_name: 0.93, ...}
    needs_review      BOOLEAN NOT NULL DEFAULT true,
    reviewed_at       TIMESTAMPTZ,
    reviewed_by       UUID REFERENCES admins(id) ON DELETE SET NULL,

    interest_tags     TEXT[] NOT NULL DEFAULT '{}',
    notes             TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','contacted','qualified','converted','rejected','duplicate')),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_event      ON leads(event_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_review     ON leads(needs_review) WHERE needs_review;
CREATE INDEX IF NOT EXISTS idx_leads_phone      ON leads(phone_primary);
CREATE INDEX IF NOT EXISTS idx_leads_email      ON leads(email);

-- full-text search across the useful columns
CREATE INDEX IF NOT EXISTS idx_leads_fts ON leads
USING GIN (to_tsvector('simple',
    coalesce(full_name,'')  || ' ' || coalesce(company,'')  || ' ' ||
    coalesce(email,'')      || ' ' || coalesce(phone_primary,'') || ' ' ||
    coalesce(city,'')       || ' ' || coalesce(ocr_raw_text,'')));

-- ============ updated_at triggers ============
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['admins','events','event_contacts','leads'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%1$s ON %1$s', t);
        EXECUTE format(
            'CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
    END LOOP;
END $$;
