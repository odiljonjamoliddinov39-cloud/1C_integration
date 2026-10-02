export type Role = "owner" | "accountant" | "viewer";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  totp_enabled: boolean;
  company_ids: number[] | null;
}

export interface Company {
  id: number;
  name: string;
  inn: string;
  base_path: string;
  last_synced_at: string | null;
  closed_period_until: string | null;
  agent_online: boolean | null;
  pending_commands: number | null;
}

export interface DocumentRow {
  id: number;
  company_id: number;
  ref_1c: string;
  type: string;
  number: string;
  date: string;
  posted: boolean;
  deleted: boolean;
  counterparty_ref: string | null;
  counterparty?: string;
  contract_ref: string | null;
  amount: string;
  vat: string;
}

export interface Finding {
  id: number;
  company_id: number;
  rule_code: string;
  severity: "critical" | "high" | "medium" | "low";
  object_ref: string;
  object_type: string;
  object_date: string | null;
  amount: string | null;
  message: string;
  details: Record<string, unknown>;
  fix_type: string | null;
  ai_explanation: string | null;
  status: "open" | "fixed" | "ignored";
  first_seen: string;
}

export interface FixPreview {
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  affected_entries: { date: string; dt: string; kt: string; amount: string }[];
}

export interface Fix {
  id: number;
  company_id: number;
  finding_id: number | null;
  fix_type: string;
  proposed_change: { type: string; object: { kind: string; type?: string; ref: string }; changes: Record<string, unknown> };
  explanation: string;
  status: "proposed" | "approved" | "applied" | "failed" | "rejected";
  approval_id: string | null;
  approved_at: string | null;
  applied_at: string | null;
  result: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reverses_fix_id: number | null;
  created_at: string;
  preview?: FixPreview | null;
  finding?: Finding | null;
}

export interface InvoiceRow {
  item_ref: string;
  name?: string;
  unit?: string;
  ikpu_code?: string;
  quantity: string | number;
  price?: string | number;
  vat_rate?: string | number;
  amount?: string;
  vat?: string;
}

export interface ValidationError {
  field: string;
  message: string;
  row?: number;
  line?: number;
}

export interface Invoice {
  id: number;
  company_id: number;
  ref_1c: string | null;
  number: string;
  date: string;
  buyer_ref: string | null;
  buyer_inn: string;
  buyer_name: string;
  contract_ref: string | null;
  rows: InvoiceRow[];
  total: string;
  vat: string;
  status: string;
  operator_id: string | null;
  operator_message: string;
  updated_at: string;
  errors: ValidationError[] | null;
}

export interface Counterparty {
  ref_1c: string;
  name: string;
  inn: string;
  contracts: { ref: string; name: string; number: string; date: string | null }[];
}

export interface Item {
  ref_1c: string;
  name: string;
  unit: string;
  price: string;
  vat_rate: string | null;
  ikpu_code: string;
}
