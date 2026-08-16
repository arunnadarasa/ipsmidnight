CREATE UNIQUE INDEX IF NOT EXISTS agent_connections_user_prefix_idx
  ON public.agent_connections (user_id, app_prefix)
  WHERE app_prefix IS NOT NULL;