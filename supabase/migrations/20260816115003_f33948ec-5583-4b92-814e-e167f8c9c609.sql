ALTER TABLE public.fly_deployments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'midnight',
  ADD COLUMN IF NOT EXISTS agent_url TEXT,
  ADD COLUMN IF NOT EXISTS didcomm_url TEXT;

ALTER TABLE public.fly_deployments
  DROP CONSTRAINT IF EXISTS fly_deployments_kind_check;
ALTER TABLE public.fly_deployments
  ADD CONSTRAINT fly_deployments_kind_check CHECK (kind IN ('midnight','identus'));

DROP INDEX IF EXISTS fly_deployments_user_prefix_idx;
DROP INDEX IF EXISTS fly_deployments_user_id_app_prefix_idx;
DROP INDEX IF EXISTS fly_deployments_user_id_app_prefix_key;

CREATE UNIQUE INDEX IF NOT EXISTS fly_deployments_user_prefix_kind_idx
  ON public.fly_deployments (user_id, app_prefix, kind);

ALTER TABLE public.agent_connections
  ADD COLUMN IF NOT EXISTS app_prefix TEXT,
  ADD COLUMN IF NOT EXISTS didcomm_url TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT;