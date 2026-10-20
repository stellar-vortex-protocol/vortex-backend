-- Reverses 20261020000000_solver_fills. Per-fill rows written since the
-- migration (including fill-time USD snapshots) are lost; the legacy counters
-- on `solvers` were maintained throughout and remain intact.
DROP TABLE IF EXISTS "solver_fills";
DROP TYPE IF EXISTS "solver_fill_outcome";
