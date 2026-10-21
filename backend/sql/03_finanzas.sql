-- ============================================================
-- CAPRICHO-COMPOINT — Módulos de finanzas y nómina
-- Corte del día, gastos, surtida, hoja semanal, nómina vinculada
-- al checador (bono de puntualidad), pagos al personal y permisos.
-- Se puede correr varias veces sin dañar nada.
-- ============================================================

-- Configuración de finanzas y reglas de bonos
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS dias_operacion VARCHAR(20) NOT NULL DEFAULT 'X,J,V,S,D';
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_corte_dia INT NOT NULL DEFAULT 6;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS comision_tarjeta NUMERIC(5,2) NOT NULL DEFAULT 3.5;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS bono_puntualidad NUMERIC(10,2) NOT NULL DEFAULT 60;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS bono_semana_perfecta NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS puntualidad_tolerancia_min INT NOT NULL DEFAULT 0;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS bono_pierde_con_falta BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS aviso_corte_correo VARCHAR(150);

-- Sueldo por día y permisos de captura de cada empleado
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS sueldo_diario NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS permisos JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Catálogo de conceptos de gasto (incluye proveedores y puestos del mercado de abastos)
--   tipo: dia (se captura en el corte), semanal (renta, luz...), proveedor, abastos
--   grupo: cómo aparece en la hoja semanal (ej. "Norteño"); vacío = "Gastos del día"
CREATE TABLE IF NOT EXISTS conceptos_gasto (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(80) NOT NULL,
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('dia','semanal','proveedor','abastos')),
    grupo VARCHAR(60),
    icono VARCHAR(8),
    telefono VARCHAR(20),
    ubicacion VARCHAR(120),
    monto_sugerido NUMERIC(10,2),
    orden INT NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (nombre, tipo)
);

-- Corte del día (un registro por día de operación)
CREATE TABLE IF NOT EXISTS cortes (
    id SERIAL PRIMARY KEY,
    fecha DATE NOT NULL UNIQUE,
    venta_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    venta_tarjeta NUMERIC(12,2) NOT NULL DEFAULT 0,
    efectivo_contado NUMERIC(12,2),
    foto_terminal_url VARCHAR(500),
    notas VARCHAR(255),
    estado VARCHAR(8) NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','cerrado')),
    capturado_por VARCHAR(120),
    cerrado_por VARCHAR(120),
    cerrado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (venta_total >= 0 AND venta_tarjeta >= 0 AND venta_tarjeta <= venta_total)
);

-- Gastos (del día, semanales, surtida de proveedores y de abastos)
CREATE TABLE IF NOT EXISTS gastos (
    id SERIAL PRIMARY KEY,
    fecha DATE NOT NULL,
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('dia','semanal','proveedor','abastos')),
    concepto_id INT REFERENCES conceptos_gasto(id) ON DELETE SET NULL,
    concepto VARCHAR(80) NOT NULL,
    monto NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    nota VARCHAR(160),
    capturado_por VARCHAR(120),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos (fecha);

-- Bonos extra (o descuentos, con monto negativo) por empleado y semana
CREATE TABLE IF NOT EXISTS bonos_extra (
    id SERIAL PRIMARY KEY,
    semana DATE NOT NULL,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    concepto VARCHAR(80) NOT NULL,
    monto NUMERIC(10,2) NOT NULL CHECK (monto <> 0),
    creado_por VARCHAR(120),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bonos_semana ON bonos_extra (semana);

-- Pagos de nómina (foto fija de lo que se pagó a cada quien esa semana)
CREATE TABLE IF NOT EXISTS nomina_pagos (
    id SERIAL PRIMARY KEY,
    semana DATE NOT NULL,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    dias_trabajados INT NOT NULL,
    dias_puntuales INT NOT NULL,
    sueldo_diario NUMERIC(10,2) NOT NULL,
    sueldo NUMERIC(12,2) NOT NULL,
    bono_puntualidad NUMERIC(12,2) NOT NULL,
    bonos_extra NUMERIC(12,2) NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    detalle JSONB,
    metodo VARCHAR(15) NOT NULL CHECK (metodo IN ('efectivo','transferencia')),
    pagado_por VARCHAR(120),
    pagado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recibido_en TIMESTAMPTZ,
    UNIQUE (semana, empleado_id)
);

-- Auditoría de cambios en finanzas (cortes corregidos, gastos borrados, pagos deshechos)
CREATE TABLE IF NOT EXISTS auditoria_finanzas (
    id SERIAL PRIMARY KEY,
    modulo VARCHAR(20) NOT NULL,
    registro_id INT,
    accion VARCHAR(20) NOT NULL,
    descripcion VARCHAR(255),
    antes JSONB,
    despues JSONB,
    usuario VARCHAR(120),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Catálogo inicial tomado de la hoja semanal (solo si está vacío)
INSERT INTO conceptos_gasto (nombre, tipo, grupo, icono, telefono, ubicacion, monto_sugerido, orden)
SELECT * FROM (VALUES
  ('Hielo', 'dia', NULL, '🧊', NULL, NULL, NULL::numeric, 1),
  ('Limones', 'dia', NULL, '🍋', NULL, NULL, NULL, 2),
  ('Garrafones', 'dia', NULL, '💧', NULL, NULL, NULL, 3),
  ('Norteño', 'dia', 'Norteño', '🎸', NULL, NULL, 3500, 4),
  ('Striper', 'dia', 'Stripers', '💃', NULL, NULL, 2500, 5),
  ('Otro', 'dia', NULL, '🧾', NULL, NULL, NULL, 9),
  ('Gasto semana', 'semanal', NULL, NULL, NULL, NULL, NULL, 1),
  ('Renta', 'semanal', NULL, NULL, NULL, NULL, NULL, 2),
  ('Luz', 'semanal', NULL, NULL, NULL, NULL, NULL, 3),
  ('Policía', 'semanal', NULL, NULL, NULL, NULL, NULL, 4),
  ('Norteño', 'semanal', 'Norteño', NULL, NULL, NULL, NULL, 5),
  ('Stripers', 'semanal', 'Stripers', NULL, NULL, NULL, NULL, 6),
  ('Alex bebidas', 'proveedor', NULL, NULL, '3347516235', NULL, NULL, 1),
  ('Alitas', 'proveedor', NULL, NULL, '3315137374', NULL, NULL, 2),
  ('Congelados', 'proveedor', NULL, NULL, '3313503828', NULL, NULL, 3),
  ('Pulpamia', 'proveedor', NULL, NULL, '3317669607', NULL, NULL, 4),
  ('Hielo', 'proveedor', NULL, NULL, '3339595947', NULL, NULL, 5),
  ('Botana, aceite', 'proveedor', NULL, NULL, '3332286802', NULL, NULL, 6),
  ('Arrachera', 'proveedor', NULL, NULL, '3338098961', NULL, NULL, 7),
  ('Extras', 'proveedor', NULL, NULL, NULL, NULL, NULL, 9),
  ('Dulcería', 'abastos', NULL, NULL, NULL, 'Calle 1', NULL, 1),
  ('Naranja', 'abastos', NULL, NULL, NULL, 'Calle Avispa', NULL, 2),
  ('Toronja', 'abastos', NULL, NULL, NULL, 'Calle Avispa', NULL, 3),
  ('Limón', 'abastos', NULL, NULL, NULL, 'Mandarina y C. 5', NULL, 4),
  ('Verdura', 'abastos', NULL, NULL, NULL, 'Calle 9', NULL, 5),
  ('Jarcería', 'abastos', NULL, NULL, NULL, 'Av. del Mercado, c14', NULL, 6),
  ('Cremería', 'abastos', NULL, NULL, NULL, 'Calle 15', NULL, 7),
  ('Plásticos', 'abastos', NULL, NULL, NULL, 'Calle 15', NULL, 8),
  ('Cereales', 'abastos', NULL, NULL, NULL, 'Calle 15', NULL, 9),
  ('Mixdrink', 'abastos', NULL, NULL, NULL, 'Calle Nuez', NULL, 10),
  ('El Valor', 'abastos', NULL, NULL, NULL, 'Calle Nuez', NULL, 11),
  ('Extras', 'abastos', NULL, NULL, NULL, NULL, NULL, 12)
) AS v(nombre, tipo, grupo, icono, telefono, ubicacion, monto_sugerido, orden)
WHERE NOT EXISTS (SELECT 1 FROM conceptos_gasto);
