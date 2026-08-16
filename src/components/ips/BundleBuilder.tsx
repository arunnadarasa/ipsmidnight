import { Plus, Trash2 } from "lucide-react";
import type { BuilderState } from "@/lib/ips/builder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
};

type ListKey = "problems" | "allergies" | "medications" | "immunizations" | "results";

const LIST_META: Record<
  ListKey,
  { title: string; blurb: string; fields: { key: string; label: string; placeholder?: string; width?: string }[] }
> = {
  problems: {
    title: "Active problems",
    blurb: "Conditions coded with SNOMED CT where available.",
    fields: [
      { key: "display", label: "Condition", placeholder: "Type 2 diabetes mellitus" },
      { key: "snomed", label: "SNOMED", placeholder: "44054006", width: "sm:w-40" },
      { key: "onset", label: "Onset", placeholder: "2019-04-01", width: "sm:w-40" },
    ],
  },
  allergies: {
    title: "Allergies and intolerances",
    blurb: "Required section — record 'no known allergies' explicitly if applicable.",
    fields: [
      { key: "display", label: "Substance / reaction", placeholder: "Penicillin allergy" },
      { key: "snomed", label: "SNOMED", placeholder: "294505008", width: "sm:w-40" },
      { key: "criticality", label: "Criticality", placeholder: "high", width: "sm:w-32" },
    ],
  },
  medications: {
    title: "Medication summary",
    blurb: "Current medication statements.",
    fields: [
      { key: "display", label: "Medication", placeholder: "Metformin 500mg tablet" },
      { key: "snomed", label: "SNOMED", placeholder: "109081006", width: "sm:w-40" },
      { key: "dosage", label: "Dosage", placeholder: "500 mg twice daily", width: "sm:w-48" },
    ],
  },
  immunizations: {
    title: "Immunizations",
    blurb: "Vaccination history.",
    fields: [
      { key: "display", label: "Vaccine", placeholder: "Influenza vaccination" },
      { key: "snomed", label: "SNOMED", placeholder: "86198006", width: "sm:w-40" },
      { key: "date", label: "Date", placeholder: "2025-10-02", width: "sm:w-40" },
    ],
  },
  results: {
    title: "Results",
    blurb: "Key observations, coded with LOINC.",
    fields: [
      { key: "display", label: "Observation", placeholder: "Haemoglobin A1c" },
      { key: "loinc", label: "LOINC", placeholder: "4548-4", width: "sm:w-36" },
      { key: "value", label: "Value", placeholder: "53", width: "sm:w-28" },
      { key: "unit", label: "Unit", placeholder: "mmol/mol", width: "sm:w-32" },
      { key: "date", label: "Date", placeholder: "2026-02-10", width: "sm:w-40" },
    ],
  },
};

export function BundleBuilder({ state, onChange }: Props) {
  const setPatient = (key: keyof BuilderState["patient"], value: string) =>
    onChange({ ...state, patient: { ...state.patient, [key]: value } });

  const rows = (key: ListKey) => state[key] as Record<string, string>[];

  const addRow = (key: ListKey) =>
    onChange({ ...state, [key]: [...rows(key), {}] } as BuilderState);

  const removeRow = (key: ListKey, index: number) =>
    onChange({ ...state, [key]: rows(key).filter((_, i) => i !== index) } as BuilderState);

  const setCell = (key: ListKey, index: number, field: string, value: string) =>
    onChange({
      ...state,
      [key]: rows(key).map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    } as BuilderState);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ips-title">Summary title</Label>
          <Input
            id="ips-title"
            value={state.title}
            onChange={(e) => onChange({ ...state, title: e.target.value })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Given name" value={state.patient.given} onChange={(v) => setPatient("given", v)} />
          <Field label="Family name" value={state.patient.family} onChange={(v) => setPatient("family", v)} />
          <div className="space-y-1.5">
            <Label>Gender</Label>
            <Select
              value={state.patient.gender || undefined}
              onValueChange={(v) => setPatient("gender", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {["female", "male", "other", "unknown"].map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Field
            label="Date of birth"
            type="date"
            value={state.patient.birthDate}
            onChange={(v) => setPatient("birthDate", v)}
          />
          <Field
            label="Patient identifier"
            value={state.patient.identifier}
            onChange={(v) => setPatient("identifier", v)}
            placeholder="9876543210"
          />
          <Field
            label="Identifier system"
            value={state.patient.identifierSystem}
            onChange={(v) => setPatient("identifierSystem", v)}
          />
          <Field label="City" value={state.patient.city} onChange={(v) => setPatient("city", v)} />
          <Field
            label="Country (ISO)"
            value={state.patient.country}
            onChange={(v) => setPatient("country", v.toUpperCase().slice(0, 2))}
          />
        </div>
      </div>

      {(Object.keys(LIST_META) as ListKey[]).map((key) => {
        const meta = LIST_META[key];
        return (
          <section key={key} className="space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{meta.title}</h3>
                <p className="text-xs text-muted-foreground">{meta.blurb}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => addRow(key)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>

            {rows(key).length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                Nothing recorded.
              </p>
            ) : (
              <ul className="space-y-2">
                {rows(key).map((row, index) => (
                  <li
                    key={index}
                    className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3 sm:flex-row sm:items-end"
                  >
                    {meta.fields.map((f) => (
                      <div key={f.key} className={`min-w-0 flex-1 space-y-1 ${f.width ?? ""}`}>
                        <Label className="text-xs text-muted-foreground">{f.label}</Label>
                        <Input
                          value={row[f.key] ?? ""}
                          placeholder={f.placeholder}
                          onChange={(e) => setCell(key, index, f.key, e.target.value)}
                        />
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove row"
                      className="shrink-0 self-end text-muted-foreground hover:text-destructive"
                      onClick={() => removeRow(key, index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
