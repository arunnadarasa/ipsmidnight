CREATE TABLE public.midnight_contracts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users,
  app_prefix TEXT NOT NULL,
  contract_name TEXT NOT NULL DEFAULT 'IpsAnchorRegistry',
  address TEXT NOT NULL,
  deploy_tx TEXT,
  network TEXT NOT NULL DEFAULT 'undeployed',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, app_prefix, contract_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.midnight_contracts TO authenticated;
GRANT ALL ON public.midnight_contracts TO service_role;

ALTER TABLE public.midnight_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own deployed contracts"
  ON public.midnight_contracts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_midnight_contracts_updated_at
  BEFORE UPDATE ON public.midnight_contracts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();