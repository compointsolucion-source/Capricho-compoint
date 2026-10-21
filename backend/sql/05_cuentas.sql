-- Cuentas: correo para recuperar contraseña/PIN y código de recuperación

ALTER TABLE administradores ADD COLUMN IF NOT EXISTS correo VARCHAR(150);
-- Código de recuperación (se muestra una sola vez; aquí solo su huella bcrypt)
ALTER TABLE administradores ADD COLUMN IF NOT EXISTS codigo_recuperacion_hash VARCHAR(255);
ALTER TABLE administradores ADD COLUMN IF NOT EXISTS codigo_recuperacion_en TIMESTAMPTZ;

ALTER TABLE empleados ADD COLUMN IF NOT EXISTS correo VARCHAR(150);

-- Enlaces de "olvidé mi contraseña / PIN" (válidos 30 minutos, un solo uso)
CREATE TABLE IF NOT EXISTS recuperaciones (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('admin', 'empleado')),
    cuenta_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expira_en TIMESTAMPTZ NOT NULL,
    usado_en TIMESTAMPTZ,
    ip VARCHAR(60),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recuperaciones_cuenta ON recuperaciones (tipo, cuenta_id);
