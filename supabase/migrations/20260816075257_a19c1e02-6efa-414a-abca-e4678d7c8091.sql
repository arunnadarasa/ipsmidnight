-- One Fly stack row per user + app prefix so provisioning is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS fly_deployments_user_prefix_key
  ON public.fly_deployments (user_id, app_prefix);

-- Anchors are unique per bundle digest + network, so re-anchoring updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS midnight_anchors_user_digest_key
  ON public.midnight_anchors (user_id, digest, network);