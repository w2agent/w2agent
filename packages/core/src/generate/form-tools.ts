import type { ExtractedForm, ExtractedFormField } from "./types.js";

export type FormMethod = "GET" | "POST";

export type FormFieldKind =
  | "string"
  | "number"
  | "checkbox"
  | "checkbox-group"
  | "radio"
  | "select";

export interface FormFieldSpec {
  name: string;
  kind: FormFieldKind;
  required: boolean;
  label: string;
  value?: string;
  options?: string[];
}

export interface FormToolSpec {
  method: FormMethod;
  fields: FormFieldSpec[];
}

const NON_PARAMETER_TYPES = new Set(["file", "hidden", "submit", "button", "reset", "image"]);

// HTML's method attribute is an enumerated attribute: "post" is POST, "dialog" closes a
// dialog (no request), and a missing or unknown value falls back to GET.
export function normalizeFormMethod(method: string | undefined): FormMethod | null {
  const m = (method ?? "").toLowerCase();
  if (m === "dialog") return null;
  return m === "post" ? "POST" : "GET";
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const out = [...new Set(values.filter((v) => typeof v === "string"))];
  return out.length > 0 ? out : undefined;
}

function toFieldSpec(f: ExtractedFormField): FormFieldSpec {
  const type = (f.type ?? "text").toLowerCase();
  const options = uniqueStrings(f.options);
  const spec: FormFieldSpec = {
    name: f.name,
    kind: "string",
    required: f.required,
    label: f.label || f.name,
  };
  if (type === "checkbox") {
    if (options) {
      spec.kind = "checkbox-group";
      spec.options = options;
    } else {
      spec.kind = "checkbox";
      spec.value = f.value ?? "on";
    }
  } else if ((type === "radio" || type === "select") && options) {
    spec.kind = type;
    spec.options = options;
  } else if (type === "number" || type === "range") {
    spec.kind = "number";
  }
  return spec;
}

// The single rule for "can an agent call this form as a tool, and with which parameters".
// Credentials never become tool parameters, a required file cannot be supplied, and
// dialog forms send nothing.
export function formToolSpec(form: Pick<ExtractedForm, "method" | "fields">): FormToolSpec | null {
  const method = normalizeFormMethod(form.method);
  if (!method) return null;
  const fields = Array.isArray(form.fields) ? form.fields : [];
  for (const f of fields) {
    const type = (f.type ?? "text").toLowerCase();
    if (type === "password") return null;
    if (type === "file" && f.required) return null;
  }
  const seen = new Set<string>();
  const params: FormFieldSpec[] = [];
  for (const f of fields) {
    // zod drops "__proto__" and the generated runtime reads params by own key, so names
    // that exist on Object.prototype are not offered as parameters in any variant.
    if (typeof f.name !== "string" || f.name === "" || f.name in Object.prototype) continue;
    if (seen.has(f.name)) continue;
    if (NON_PARAMETER_TYPES.has((f.type ?? "text").toLowerCase())) continue;
    seen.add(f.name);
    params.push(toFieldSpec(f));
  }
  if (params.length === 0) return null;
  return { method, fields: params };
}

// The URL a submission actually hits: no fragment, and for GET no query (the submission
// replaces it). Null when the action carries credentials.
export function formRequestUrl(resolved: URL, method: FormMethod): string | null {
  if (resolved.username || resolved.password) return null;
  const url = new URL(resolved.href);
  url.hash = "";
  if (method === "GET") url.search = "";
  return url.href;
}

export function formContractKey(requestUrl: string, spec: FormToolSpec): string {
  return JSON.stringify([
    requestUrl,
    spec.method,
    spec.fields.map((f) => [f.name, f.kind, f.required, f.options ?? null, f.value ?? null]),
  ]);
}
