DROP INDEX IF EXISTS public.fly_deployments_user_prefix_key;
DROP INDEX IF EXISTS public.agent_connections_user_prefix_idx;
CREATE UNIQUE INDEX agent_connections_user_prefix_idx ON public.agent_connections (user_id, app_prefix);