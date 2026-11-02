-- Permiso del empleado para usar su foto y su selfie al checar (datos biométricos).
-- Ley Federal de Protección de Datos Personales en Posesión de los Particulares (2025), art. 8:
-- para datos sensibles se pide consentimiento expreso y por escrito (aquí: lo acepta con su PIN).
--   consentimiento_fotos: NULL = no se le ha preguntado · 'acepto' · 'rechazo' (checa solo con PIN)
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS consentimiento_fotos VARCHAR(10);
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS consentimiento_en TIMESTAMPTZ;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS consentimiento_version VARCHAR(20);
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS consentimiento_medio VARCHAR(20);
DO $$ BEGIN
  ALTER TABLE empleados ADD CONSTRAINT empleados_consentimiento_fotos_chk
    CHECK (consentimiento_fotos IS NULL OR consentimiento_fotos IN ('acepto', 'rechazo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Domicilio del negocio: lo pide el aviso de privacidad para empleados (art. 15, fr. I)
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS empresa_domicilio VARCHAR(250);
