CREATE TABLE public.identus_db_credentials (
  app_name TEXT PRIMARY KEY,
  superuser_password TEXT NOT NULL,
  app_role_password TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT ALL ON public.identus_db_credentials TO service_role;

ALTER TABLE public.identus_db_credentials ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: these are server-only secrets. service_role bypasses
-- RLS; anon and authenticated have no grants and no policies, so the Data API
-- cannot reach this table at all.

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_identus_db_credentials_updated_at
BEFORE UPDATE ON public.identus_db_credentials
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();