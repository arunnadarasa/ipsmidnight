-- === roles =========================================================
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_roles_select_own" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- === identus agents ================================================
CREATE TABLE public.agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  mode text NOT NULL DEFAULT 'simulated',
  base_url text,
  api_key text,
  readiness_status text NOT NULL DEFAULT 'unknown',
  is_active boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_connections TO authenticated;
GRANT ALL ON public.agent_connections TO service_role;
ALTER TABLE public.agent_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agents_own" ON public.agent_connections FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER agents_set_updated_at BEFORE UPDATE ON public.agent_connections
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- === fly deployments ===============================================
CREATE TABLE public.fly_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_prefix text NOT NULL,
  region text NOT NULL DEFAULT 'lhr',
  status text NOT NULL DEFAULT 'provisioning',
  node_url text,
  indexer_url text,
  indexer_ws_url text,
  proof_url text,
  faucet_url text,
  machines jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fly_deployments TO authenticated;
GRANT ALL ON public.fly_deployments TO service_role;
ALTER TABLE public.fly_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fly_own" ON public.fly_deployments FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER fly_set_updated_at BEFORE UPDATE ON public.fly_deployments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- === IPS bundles ===================================================
CREATE TABLE public.ips_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  patient_name text,
  patient_dob date,
  source text NOT NULL DEFAULT 'builder',
  bundle jsonb NOT NULL,
  digest text,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ips_bundles TO authenticated;
GRANT ALL ON public.ips_bundles TO service_role;
ALTER TABLE public.ips_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ips_own" ON public.ips_bundles FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER ips_set_updated_at BEFORE UPDATE ON public.ips_bundles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.sample_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  provenance text,
  bundle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sample_bundles TO authenticated;
GRANT SELECT ON public.sample_bundles TO anon;
GRANT ALL ON public.sample_bundles TO service_role;
ALTER TABLE public.sample_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "samples_public_read" ON public.sample_bundles FOR SELECT TO anon, authenticated USING (true);

-- === credentials ===================================================
CREATE TABLE public.credential_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bundle_id uuid REFERENCES public.ips_bundles(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES public.agent_connections(id) ON DELETE SET NULL,
  record_id text,
  issuer_did text,
  subject_did text,
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_jwt text,
  invitation_url text,
  state text NOT NULL DEFAULT 'OfferSent',
  simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credential_records TO authenticated;
GRANT ALL ON public.credential_records TO service_role;
ALTER TABLE public.credential_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "creds_own" ON public.credential_records FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER creds_set_updated_at BEFORE UPDATE ON public.credential_records
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- === midnight anchors ==============================================
CREATE TABLE public.midnight_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bundle_id uuid REFERENCES public.ips_bundles(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES public.credential_records(id) ON DELETE SET NULL,
  digest text NOT NULL,
  commitment text,
  entry_id text,
  contract_address text,
  tx_hash text,
  block_height bigint,
  entry_point text,
  network text NOT NULL DEFAULT 'undeployed',
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.midnight_anchors TO authenticated;
GRANT ALL ON public.midnight_anchors TO service_role;
ALTER TABLE public.midnight_anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anchors_own" ON public.midnight_anchors FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER anchors_set_updated_at BEFORE UPDATE ON public.midnight_anchors
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- === activity ======================================================
CREATE TABLE public.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.activity_log TO authenticated;
GRANT ALL ON public.activity_log TO service_role;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activity_own" ON public.activity_log FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX activity_log_user_created_idx ON public.activity_log (user_id, created_at DESC);

-- === seeded sample IPS bundles ======================================
INSERT INTO public.sample_bundles (slug, title, description, provenance, bundle) VALUES
('hl7-ips-minimal', 'HL7 IPS — Martha Minimal', 'Minimal conformant International Patient Summary with the three required sections: problems, allergies and medications.', 'Shaped after the HL7 IPS implementation guide examples (hl7.org/fhir/uv/ips).', '{"resourceType":"Bundle","id":"ips-minimal-martha","type":"document","timestamp":"2026-02-11T09:30:00Z","identifier":{"system":"urn:oid:2.16.724.4.8.10.200.10","value":"ips-minimal-martha"},"entry":[{"fullUrl":"urn:uuid:comp-1","resource":{"resourceType":"Composition","id":"comp-1","status":"final","type":{"coding":[{"system":"http://loinc.org","code":"60591-5","display":"Patient summary Document"}]},"subject":{"reference":"urn:uuid:pat-1"},"date":"2026-02-11T09:30:00Z","title":"International Patient Summary","section":[{"title":"Active Problems","code":{"coding":[{"system":"http://loinc.org","code":"11450-4"}]},"entry":[{"reference":"urn:uuid:cond-1"}]},{"title":"Allergies and Intolerances","code":{"coding":[{"system":"http://loinc.org","code":"48765-2"}]},"entry":[{"reference":"urn:uuid:alg-1"}]},{"title":"Medication Summary","code":{"coding":[{"system":"http://loinc.org","code":"10160-0"}]},"entry":[{"reference":"urn:uuid:med-1"}]}]}},{"fullUrl":"urn:uuid:pat-1","resource":{"resourceType":"Patient","id":"pat-1","name":[{"family":"Minimal","given":["Martha"]}],"gender":"female","birthDate":"1953-04-12","address":[{"country":"NL","city":"Utrecht"}]}},{"fullUrl":"urn:uuid:cond-1","resource":{"resourceType":"Condition","id":"cond-1","clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"code":{"coding":[{"system":"http://snomed.info/sct","code":"38341003","display":"Hypertensive disorder"}]},"subject":{"reference":"urn:uuid:pat-1"},"onsetDateTime":"2018-06-01"}},{"fullUrl":"urn:uuid:alg-1","resource":{"resourceType":"AllergyIntolerance","id":"alg-1","clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical","code":"active"}]},"code":{"coding":[{"system":"http://snomed.info/sct","code":"373270004","display":"Penicillin allergy"}]},"patient":{"reference":"urn:uuid:pat-1"},"criticality":"high"}},{"fullUrl":"urn:uuid:med-1","resource":{"resourceType":"MedicationStatement","id":"med-1","status":"active","medicationCodeableConcept":{"coding":[{"system":"http://snomed.info/sct","code":"318272007","display":"Amlodipine 5 mg oral tablet"}]},"subject":{"reference":"urn:uuid:pat-1"},"dosage":[{"text":"5 mg once daily"}]}}]}'::jsonb),
('nhs-scr-ips', 'NHS SCR-style IPS — Ade Okafor', 'Richer summary with immunizations and results alongside the required sections, in the style of the NHS England SCR/IPS profile.', 'Shaped after NHSDigital/NHSEngland-FHIR-SCR-IPS examples.', '{"resourceType":"Bundle","id":"ips-nhs-ade","type":"document","timestamp":"2026-05-02T14:05:00Z","identifier":{"system":"https://fhir.nhs.uk/Id/ips","value":"ips-nhs-ade"},"entry":[{"fullUrl":"urn:uuid:comp-1","resource":{"resourceType":"Composition","id":"comp-1","status":"final","type":{"coding":[{"system":"http://loinc.org","code":"60591-5","display":"Patient summary Document"}]},"subject":{"reference":"urn:uuid:pat-1"},"date":"2026-05-02T14:05:00Z","title":"International Patient Summary","section":[{"title":"Active Problems","code":{"coding":[{"system":"http://loinc.org","code":"11450-4"}]},"entry":[{"reference":"urn:uuid:cond-1"},{"reference":"urn:uuid:cond-2"}]},{"title":"Allergies and Intolerances","code":{"coding":[{"system":"http://loinc.org","code":"48765-2"}]},"entry":[{"reference":"urn:uuid:alg-1"}]},{"title":"Medication Summary","code":{"coding":[{"system":"http://loinc.org","code":"10160-0"}]},"entry":[{"reference":"urn:uuid:med-1"},{"reference":"urn:uuid:med-2"}]},{"title":"Immunizations","code":{"coding":[{"system":"http://loinc.org","code":"11369-6"}]},"entry":[{"reference":"urn:uuid:imm-1"}]},{"title":"Results","code":{"coding":[{"system":"http://loinc.org","code":"30954-2"}]},"entry":[{"reference":"urn:uuid:obs-1"}]}]}},{"fullUrl":"urn:uuid:pat-1","resource":{"resourceType":"Patient","id":"pat-1","identifier":[{"system":"https://fhir.nhs.uk/Id/nhs-number","value":"9000000009"}],"name":[{"family":"Okafor","given":["Ade"]}],"gender":"male","birthDate":"1979-11-23","address":[{"country":"GB","city":"Manchester","postalCode":"M1 4BT"}]}},{"fullUrl":"urn:uuid:cond-1","resource":{"resourceType":"Condition","id":"cond-1","clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"code":{"coding":[{"system":"http://snomed.info/sct","code":"44054006","display":"Type 2 diabetes mellitus"}]},"subject":{"reference":"urn:uuid:pat-1"},"onsetDateTime":"2015-09-14"}},{"fullUrl":"urn:uuid:cond-2","resource":{"resourceType":"Condition","id":"cond-2","clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"code":{"coding":[{"system":"http://snomed.info/sct","code":"195967001","display":"Asthma"}]},"subject":{"reference":"urn:uuid:pat-1"}}},{"fullUrl":"urn:uuid:alg-1","resource":{"resourceType":"AllergyIntolerance","id":"alg-1","clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical","code":"active"}]},"code":{"coding":[{"system":"http://snomed.info/sct","code":"91936005","display":"Allergy to penicillin"}]},"patient":{"reference":"urn:uuid:pat-1"},"criticality":"high","reaction":[{"manifestation":[{"coding":[{"system":"http://snomed.info/sct","code":"247472004","display":"Urticaria"}]}]}]}},{"fullUrl":"urn:uuid:med-1","resource":{"resourceType":"MedicationStatement","id":"med-1","status":"active","medicationCodeableConcept":{"coding":[{"system":"http://snomed.info/sct","code":"325278007","display":"Metformin 500 mg oral tablet"}]},"subject":{"reference":"urn:uuid:pat-1"},"dosage":[{"text":"500 mg twice daily with food"}]}},{"fullUrl":"urn:uuid:med-2","resource":{"resourceType":"MedicationStatement","id":"med-2","status":"active","medicationCodeableConcept":{"coding":[{"system":"http://snomed.info/sct","code":"320057007","display":"Salbutamol 100 microgram inhaler"}]},"subject":{"reference":"urn:uuid:pat-1"},"dosage":[{"text":"2 puffs as required"}]}},{"fullUrl":"urn:uuid:imm-1","resource":{"resourceType":"Immunization","id":"imm-1","status":"completed","vaccineCode":{"coding":[{"system":"http://snomed.info/sct","code":"1119349007","display":"COVID-19 mRNA vaccine"}]},"patient":{"reference":"urn:uuid:pat-1"},"occurrenceDateTime":"2025-10-04"}},{"fullUrl":"urn:uuid:obs-1","resource":{"resourceType":"Observation","id":"obs-1","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"Hemoglobin A1c"}]},"subject":{"reference":"urn:uuid:pat-1"},"effectiveDateTime":"2026-04-20","valueQuantity":{"value":7.1,"unit":"%","system":"http://unitsofmeasure.org","code":"%"}}}]}'::jsonb);