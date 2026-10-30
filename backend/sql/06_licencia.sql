-- Licencia de Compoint Check: la última respuesta firmada de compoint.com.mx (se guarda para
-- que el estado sobreviva a los reinicios del servidor). Si el sistema no tiene token, no se usa.
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS licencia JSONB;
