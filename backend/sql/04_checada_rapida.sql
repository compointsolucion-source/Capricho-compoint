-- Checada rápida: celular registrado por empleado + selfie de evidencia
-- La comparación del rostro se hace después (en las pantallas del panel) y
-- las checadas que no coinciden quedan "por revisar" para el administrador.

ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS requiere_dispositivo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS umbral_facial NUMERIC(4,2) NOT NULL DEFAULT 0.60;

-- Rasgos del rostro de la foto del expediente (128 números). Se calculan una sola vez.
-- descriptor_foto = foto_url con la que se calcularon (si cambia la foto, se recalculan).
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS descriptor_facial JSONB;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS descriptor_foto VARCHAR(500);

-- Estado de la revisión del rostro de cada checada:
--   pendiente  → se guardó la selfie, falta compararla
--   ok         → coincide con el expediente
--   revisar    → no coincide / no se ve el rostro / sin foto de expediente (lo decide el admin)
--   aprobada   → el admin confirmó que sí es la persona
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS revision VARCHAR(12);
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS revision_motivo VARCHAR(200);
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS distancia_facial NUMERIC(5,3);
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS revisado_por VARCHAR(150);
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS revisado_en TIMESTAMPTZ;
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS dispositivo_id INT;
CREATE INDEX IF NOT EXISTS idx_checadas_revision ON checadas (revision) WHERE revision IN ('pendiente', 'revisar');

-- Celular registrado de cada empleado (solo se guarda la huella SHA-256 del código del celular)
CREATE TABLE IF NOT EXISTS dispositivos (
    id SERIAL PRIMARY KEY,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    descripcion VARCHAR(200),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultimo_uso TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivo_activo_empleado ON dispositivos (empleado_id) WHERE activo;

-- Auditoría: también registra cuando el admin confirma una checada "por revisar"
ALTER TABLE auditoria_checadas DROP CONSTRAINT IF EXISTS auditoria_checadas_accion_check;
ALTER TABLE auditoria_checadas ADD CONSTRAINT auditoria_checadas_accion_check CHECK (accion IN ('creada','editada','eliminada','aprobada'));
