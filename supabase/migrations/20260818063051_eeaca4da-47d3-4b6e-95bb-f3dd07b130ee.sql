-- 1. Storage: owner-scoped policies for the private midnight-artifacts bucket.
-- Files must live under a top-level folder named after the owner's user id.
DROP POLICY IF EXISTS "midnight_artifacts_select_own" ON storage.objects;
DROP POLICY IF EXISTS "midnight_artifacts_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "midnight_artifacts_update_own" ON storage.objects;
DROP POLICY IF EXISTS "midnight_artifacts_delete_own" ON storage.objects;

CREATE POLICY "midnight_artifacts_select_own"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'midnight-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "midnight_artifacts_insert_own"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'midnight-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "midnight_artifacts_update_own"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'midnight-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'midnight-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "midnight_artifacts_delete_own"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'midnight-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 2. user_roles: explicit deny for all client-side writes (roles are assigned
-- only by the signup trigger / service role), plus privilege removal.
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
REVOKE ALL ON public.user_roles FROM anon;

DROP POLICY IF EXISTS "user_roles_no_client_insert" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_no_client_update" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_no_client_delete" ON public.user_roles;

CREATE POLICY "user_roles_no_client_insert"
ON public.user_roles FOR INSERT TO authenticated, anon WITH CHECK (false);

CREATE POLICY "user_roles_no_client_update"
ON public.user_roles FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY "user_roles_no_client_delete"
ON public.user_roles FOR DELETE TO authenticated, anon USING (false);

-- 3. SECURITY DEFINER functions must not be callable by API roles.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;