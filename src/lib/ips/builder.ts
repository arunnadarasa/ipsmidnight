import type { FhirBundle, FhirBundleEntry, FhirResource } from "./types";

export type BuilderProblem = { display: string; snomed?: string; onset?: string };
export type BuilderAllergy = { display: string; snomed?: string; criticality?: "low" | "high" | "unable-to-assess" };
export type BuilderMedication = { display: string; snomed?: string; dosage?: string };
export type BuilderImmunization = { display: string; snomed?: string; date?: string };
export type BuilderResult = { display: string; loinc?: string; value?: string; unit?: string; date?: string };

export type BuilderState = {
  title: string;
  patient: {
    given: string;
    family: string;
    gender: "male" | "female" | "other" | "unknown" | "";
    birthDate: string;
    identifier: string;
    identifierSystem: string;
    country: string;
    city: string;
  };
  problems: BuilderProblem[];
  allergies: BuilderAllergy[];
  medications: BuilderMedication[];
  immunizations: BuilderImmunization[];
  results: BuilderResult[];
};

export const emptyBuilderState: BuilderState = {
  title: "International Patient Summary",
  patient: {
    given: "",
    family: "",
    gender: "",
    birthDate: "",
    identifier: "",
    identifierSystem: "https://fhir.nhs.uk/Id/nhs-number",
    country: "GB",
    city: "",
  },
  problems: [],
  allergies: [],
  medications: [],
  immunizations: [],
  results: [],
};

const SNOMED = "http://snomed.info/sct";
const LOINC = "http://loinc.org";

function concept(display: string, code: string | undefined, system: string) {
  return code ? { coding: [{ system, code, display }], text: display } : { text: display };
}

/** Deterministic ids so re-generating the same form yields the same digest. */
function makeId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}

export function buildIpsBundle(state: BuilderState, timestamp: string): FhirBundle {
  const entries: FhirBundleEntry[] = [];
  const patientRef = "urn:uuid:pat-1";
  const push = (id: string, resource: FhirResource) =>
    entries.push({ fullUrl: `urn:uuid:${id}`, resource: { ...resource, id } });

  const sectionEntries: Record<string, { reference: string }[]> = {
    problems: [],
    allergies: [],
    medications: [],
    immunizations: [],
    results: [],
  };

  state.problems.forEach((p, i) => {
    const id = makeId("cond", i);
    sectionEntries["problems"]!.push({ reference: `urn:uuid:${id}` });
    push(id, {
      resourceType: "Condition",
      clinicalStatus: {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" },
        ],
      },
      code: concept(p.display, p.snomed, SNOMED),
      subject: { reference: patientRef },
      ...(p.onset ? { onsetDateTime: p.onset } : {}),
    });
  });

  state.allergies.forEach((a, i) => {
    const id = makeId("alg", i);
    sectionEntries["allergies"]!.push({ reference: `urn:uuid:${id}` });
    push(id, {
      resourceType: "AllergyIntolerance",
      clinicalStatus: {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" },
        ],
      },
      code: concept(a.display, a.snomed, SNOMED),
      patient: { reference: patientRef },
      ...(a.criticality ? { criticality: a.criticality } : {}),
    });
  });

  state.medications.forEach((m, i) => {
    const id = makeId("med", i);
    sectionEntries["medications"]!.push({ reference: `urn:uuid:${id}` });
    push(id, {
      resourceType: "MedicationStatement",
      status: "active",
      medicationCodeableConcept: concept(m.display, m.snomed, SNOMED),
      subject: { reference: patientRef },
      ...(m.dosage ? { dosage: [{ text: m.dosage }] } : {}),
    });
  });

  state.immunizations.forEach((v, i) => {
    const id = makeId("imm", i);
    sectionEntries["immunizations"]!.push({ reference: `urn:uuid:${id}` });
    push(id, {
      resourceType: "Immunization",
      status: "completed",
      vaccineCode: concept(v.display, v.snomed, SNOMED),
      patient: { reference: patientRef },
      ...(v.date ? { occurrenceDateTime: v.date } : {}),
    });
  });

  state.results.forEach((r, i) => {
    const id = makeId("obs", i);
    sectionEntries["results"]!.push({ reference: `urn:uuid:${id}` });
    push(id, {
      resourceType: "Observation",
      status: "final",
      code: concept(r.display, r.loinc, LOINC),
      subject: { reference: patientRef },
      ...(r.date ? { effectiveDateTime: r.date } : {}),
      ...(r.value
        ? {
            valueQuantity: {
              value: Number.isFinite(Number(r.value)) ? Number(r.value) : undefined,
              ...(r.unit ? { unit: r.unit, system: "http://unitsofmeasure.org", code: r.unit } : {}),
              ...(Number.isFinite(Number(r.value)) ? {} : { }),
            },
            ...(Number.isFinite(Number(r.value)) ? {} : { valueString: r.value }),
          }
        : {}),
    });
  });

  const sectionDefs: { key: keyof typeof sectionEntries; title: string; loinc: string }[] = [
    { key: "problems", title: "Active Problems", loinc: "11450-4" },
    { key: "allergies", title: "Allergies and Intolerances", loinc: "48765-2" },
    { key: "medications", title: "Medication Summary", loinc: "10160-0" },
    { key: "immunizations", title: "Immunizations", loinc: "11369-6" },
    { key: "results", title: "Results", loinc: "30954-2" },
  ];

  const composition: FhirResource = {
    resourceType: "Composition",
    status: "final",
    type: { coding: [{ system: LOINC, code: "60591-5", display: "Patient summary Document" }] },
    subject: { reference: patientRef },
    date: timestamp,
    title: state.title || "International Patient Summary",
    section: sectionDefs
      .filter((s) => (sectionEntries[s.key] ?? []).length > 0 || s.loinc === "11450-4" || s.loinc === "48765-2" || s.loinc === "10160-0")
      .map((s) => ({
        title: s.title,
        code: { coding: [{ system: LOINC, code: s.loinc }] },
        entry: sectionEntries[s.key] ?? [],
      })),
  };

  const patient: FhirResource = {
    resourceType: "Patient",
    ...(state.patient.identifier
      ? { identifier: [{ system: state.patient.identifierSystem, value: state.patient.identifier }] }
      : {}),
    name: [
      {
        family: state.patient.family || undefined,
        given: state.patient.given ? [state.patient.given] : undefined,
      },
    ],
    ...(state.patient.gender ? { gender: state.patient.gender } : {}),
    ...(state.patient.birthDate ? { birthDate: state.patient.birthDate } : {}),
    ...(state.patient.country || state.patient.city
      ? {
          address: [
            {
              ...(state.patient.country ? { country: state.patient.country } : {}),
              ...(state.patient.city ? { city: state.patient.city } : {}),
            },
          ],
        }
      : {}),
  };

  return {
    resourceType: "Bundle",
    type: "document",
    timestamp,
    identifier: {
      system: "urn:ips:console",
      value: `ips-${(state.patient.family || "patient").toLowerCase().replace(/[^a-z0-9]/g, "") || "patient"}-${timestamp.slice(0, 10)}`,
    },
    entry: [
      { fullUrl: "urn:uuid:comp-1", resource: { ...composition, id: "comp-1" } },
      { fullUrl: patientRef, resource: { ...patient, id: "pat-1" } },
      ...entries,
    ],
  };
}
