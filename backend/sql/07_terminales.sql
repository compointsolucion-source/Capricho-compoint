-- Terminales: computadoras o tabletas del negocio que muestran el QR de la entrada
-- o sirven de checador. Se conectan con un código de 6 números que da el administrador.
CREATE TABLE IF NOT EXISTS terminales (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(80) NOT NULL,
    rol VARCHAR(20) NOT NULL CHECK (rol IN ('qr', 'checador', 'admin')),
    pin_salida_hash VARCHAR(100),
    token_hash CHAR(64) UNIQUE,
    codigo_hash CHAR(64),
    codigo_vence TIMESTAMPTZ,
    vinculada_en TIMESTAMPTZ,
    ultimo_contacto TIMESTAMPTZ,
    descripcion VARCHAR(200),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- En qué terminal se hizo cada checada (para negocios con varias entradas o sucursales)
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS terminal_id INT;
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS terminal_id INT REFERENCES terminales(id) ON DELETE SET NULL;

-- Logo del negocio para las pantallas de las terminales
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Nuevo método de checada: en la tableta del negocio (PIN + selfie)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checadas_metodo_check'
                 AND pg_get_constraintdef(oid) LIKE '%tableta%') THEN
    ALTER TABLE checadas DROP CONSTRAINT IF EXISTS checadas_metodo_check;
    ALTER TABLE checadas ADD CONSTRAINT checadas_metodo_check CHECK (metodo IN ('huella', 'manual', 'qr', 'tableta'));
  END IF;
END $$;
