import {
  IPS_SECTIONS,
  type FhirBundle,
  type FhirResource,
  type IpsSectionKey,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function bundleResources(bundle: FhirBundle | null | undefined): FhirResource[] {
  if (!bundle?.entry) return [];
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirResource => Boolean(r && typeof r.resourceType === "string"));
}

export function findComposition(bundle: FhirBundle | null | undefined): FhirResource | null {
  return bundleResources(bundle).find((r) => r.resourceType === "Composition") ?? null;
}

export function findPatient(bundle: FhirBundle | null | undefined): FhirResource | null {
  return bundleResources(bundle).find((r) => r.resourceType === "Patient") ?? null;
}

export function patientDisplayName(patient: FhirResource | null): string | null {
  if (!patient) return null;
  const names = Array.isArray(patient["name"]) ? (patient["name"] as Record<string, unknown>[]) : [];
  const first = names[0];
  if (!first) return null;
  const given = Array.isArray(first["given"]) ? (first["given"] as string[]).join(" ") : "";
  const family = typeof first["family"] === "string" ? first["family"] : "";
  const text = typeof first["text"] === "string" ? first["text"] : "";
  return (text || `${given} ${family}`.trim()) || null;
}

function sectionCodes(composition: FhirResource | null): Map<string, number> {
  const counts = new Map<string, number>();
  const sections = Array.isArray(composition?.["section"])
    ? (composition!["section"] as Record<string, unknown>[])
    : [];
  for (const section of sections) {
    const coding = Array.isArray(asRecord(section["code"])["coding"])
      ? (asRecord(section["code"])["coding"] as Record<string, unknown>[])
      : [];
    const entries = Array.isArray(section["entry"]) ? (section["entry"] as unknown[]).length : 0;
    for (const c of coding) {
      const code = typeof c["code"] === "string" ? c["code"] : null;
      if (code) counts.set(code, (counts.get(code) ?? 0) + entries);
    }
  }
  return counts;
}

/** Structural + IPS-profile validation. Not a substitute for the HL7 validator. */
export function validateIpsBundle(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const bundle = input as FhirBundle | null;

  if (!bundle || typeof bundle !== "object" || (bundle as FhirBundle).resourceType !== "Bundle") {
    return {
      ok: false,
      issues: [{ severity: "error", path: "resourceType", message: "Not a FHIR Bundle." }],
      sections: IPS_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        required: s.required,
        present: false,
        count: 0,
      })),
      patient: { name: null, birthDate: null, gender: null, identifier: null },
      resourceCounts: {},
    };
  }

  if (bundle.type !== "document") {
    issues.push({
      severity: "error",
      path: "Bundle.type",
      message: `IPS bundles must be of type "document" (found "${bundle.type ?? "missing"}").`,
    });
  }
  if (!bundle.timestamp) {
    issues.push({ severity: "warning", path: "Bundle.timestamp", message: "No bundle timestamp." });
  }
  if (!bundle.identifier?.value) {
    issues.push({
      severity: "warning",
      path: "Bundle.identifier",
      message: "IPS recommends a business identifier on the bundle.",
    });
  }

  const resources = bundleResources(bundle);
  const resourceCounts: Record<string, number> = {};
  for (const r of resources) resourceCounts[r.resourceType] = (resourceCounts[r.resourceType] ?? 0) + 1;

  const composition = findComposition(bundle);
  if (!composition) {
    issues.push({
      severity: "error",
      path: "Bundle.entry",
      message: "No Composition — an IPS document must lead with a Composition resource.",
    });
  } else {
    const first = bundle.entry?.[0]?.resource;
    if (first && first.resourceType !== "Composition") {
      issues.push({
        severity: "warning",
        path: "Bundle.entry[0]",
        message: "The Composition should be the first entry of the document bundle.",
      });
    }
    const typeCoding = Array.isArray(asRecord(composition["type"])["coding"])
      ? (asRecord(composition["type"])["coding"] as Record<string, unknown>[])
      : [];
    if (!typeCoding.some((c) => c["code"] === "60591-5")) {
      issues.push({
        severity: "error",
        path: "Composition.type",
        message: 'Composition.type must include LOINC 60591-5 "Patient summary Document".',
      });
    }
    if (composition["status"] !== "final") {
      issues.push({
        severity: "warning",
        path: "Composition.status",
        message: 'Composition.status is normally "final" for an issued summary.',
      });
    }
  }

  const patient = findPatient(bundle);
  if (!patient) {
    issues.push({ severity: "error", path: "Bundle.entry", message: "No Patient resource in the bundle." });
  } else {
    if (!patient["birthDate"]) {
      issues.push({
        severity: "warning",
        path: "Patient.birthDate",
        message: "No birth date — age proofs and identity matching will not work.",
      });
    }
    if (!patientDisplayName(patient)) {
      issues.push({ severity: "warning", path: "Patient.name", message: "Patient has no name." });
    }
  }

  const codeCounts = sectionCodes(composition);
  const sections = IPS_SECTIONS.map((spec) => {
    const fromComposition = codeCounts.get(spec.loinc);
    const fromResources = spec.resourceTypes.reduce((sum, t) => sum + (resourceCounts[t] ?? 0), 0);
    const count = fromComposition ?? fromResources;
    const present = fromComposition !== undefined || fromResources > 0;
    if (spec.required && !present) {
      issues.push({
        severity: "error",
        path: `Composition.section[${spec.loinc}]`,
        message: `Required IPS section missing: ${spec.title}.`,
      });
    } else if (spec.required && count === 0) {
      issues.push({
        severity: "warning",
        path: `Composition.section[${spec.loinc}]`,
        message: `${spec.title} is declared but has no entries — use a "no known information" entry instead.`,
      });
    }
    return { key: spec.key as IpsSectionKey, title: spec.title, required: spec.required, present, count };
  });

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    sections,
    patient: {
      name: patientDisplayName(patient),
      birthDate: (patient?.["birthDate"] as string | undefined) ?? null,
      gender: (patient?.["gender"] as string | undefined) ?? null,
      identifier:
        (Array.isArray(patient?.["identifier"])
          ? ((patient!["identifier"] as Record<string, unknown>[])[0]?.["value"] as string | undefined)
          : undefined) ?? null,
    },
    resourceCounts,
  };
}
