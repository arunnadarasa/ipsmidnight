export type FhirCoding = {
  system?: string;
  code?: string;
  display?: string;
};

export type FhirCodeableConcept = {
  coding?: FhirCoding[];
  text?: string;
};

export type FhirResource = {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
};

export type FhirBundleEntry = {
  fullUrl?: string;
  resource?: FhirResource;
};

export type FhirBundle = {
  resourceType: "Bundle";
  id?: string;
  type?: string;
  timestamp?: string;
  identifier?: { system?: string; value?: string };
  entry?: FhirBundleEntry[];
};

export type IpsSectionKey =
  | "problems"
  | "allergies"
  | "medications"
  | "immunizations"
  | "results"
  | "procedures"
  | "devices";

export type IpsSectionSpec = {
  key: IpsSectionKey;
  title: string;
  loinc: string;
  required: boolean;
  resourceTypes: string[];
  blurb: string;
};

/** Sections defined by the HL7 International Patient Summary IG. */
export const IPS_SECTIONS: IpsSectionSpec[] = [
  {
    key: "problems",
    title: "Active Problems",
    loinc: "11450-4",
    required: true,
    resourceTypes: ["Condition"],
    blurb: "Current conditions relevant to unscheduled care.",
  },
  {
    key: "allergies",
    title: "Allergies and Intolerances",
    loinc: "48765-2",
    required: true,
    resourceTypes: ["AllergyIntolerance"],
    blurb: "Substances to avoid, with criticality.",
  },
  {
    key: "medications",
    title: "Medication Summary",
    loinc: "10160-0",
    required: true,
    resourceTypes: ["MedicationStatement", "MedicationRequest"],
    blurb: "Medicines the patient is currently taking.",
  },
  {
    key: "immunizations",
    title: "Immunizations",
    loinc: "11369-6",
    required: false,
    resourceTypes: ["Immunization"],
    blurb: "Vaccination history.",
  },
  {
    key: "results",
    title: "Results",
    loinc: "30954-2",
    required: false,
    resourceTypes: ["Observation", "DiagnosticReport"],
    blurb: "Diagnostic results worth carrying across borders.",
  },
  {
    key: "procedures",
    title: "History of Procedures",
    loinc: "47519-4",
    required: false,
    resourceTypes: ["Procedure"],
    blurb: "Significant past procedures.",
  },
  {
    key: "devices",
    title: "Medical Devices",
    loinc: "46264-8",
    required: false,
    resourceTypes: ["DeviceUseStatement", "Device"],
    blurb: "Implants and assistive devices.",
  },
];

export type ValidationIssue = {
  severity: "error" | "warning" | "info";
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  sections: { key: IpsSectionKey; title: string; required: boolean; present: boolean; count: number }[];
  patient: { name: string | null; birthDate: string | null; gender: string | null; identifier: string | null };
  resourceCounts: Record<string, number>;
};
