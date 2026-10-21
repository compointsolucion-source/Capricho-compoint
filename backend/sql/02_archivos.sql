-- ============================================================
-- CAPRICHO-COMPOINT — Archivos (fotos de empleados, fotos de
-- checada y justificantes) guardados dentro de la base de datos.
-- En Render el disco se borra en cada despliegue, por eso no se
-- guardan en una carpeta como en XAMPP.
-- ============================================================

CREATE TABLE IF NOT EXISTS archivos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_mime VARCHAR(60) NOT NULL,
    tamano INT NOT NULL,
    datos BYTEA NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
