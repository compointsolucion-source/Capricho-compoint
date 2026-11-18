-- Limpieza automática de fotos (ley de datos personales: no guardar datos sensibles más de lo necesario).
-- Las selfies al checar se borran solas a los N días (90 de entrada); la checada se queda, solo sin foto.
-- No se tocan las que siguen "por revisar" ni la foto del expediente, justificantes, cortes ni el logo.
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS dias_selfies INT NOT NULL DEFAULT 90;

-- Para encontrar rápido las checadas viejas que todavía tienen foto
CREATE INDEX IF NOT EXISTS idx_checadas_foto_fecha ON checadas (fecha) WHERE foto_url IS NOT NULL;
