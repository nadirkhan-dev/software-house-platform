/** Shapes the API actually returns. Optional fields are optional because the
 *  server *omits* them by permission — that is the redaction contract, and
 *  making them optional in the type is what forces the UI to handle it. */

export type Role = 'admin' | 'finance' | 'sales' | 'pm' | 'lead' | 'developer' | 'designer' | 'qa' | 'client';

export interface User {
  id: string; name: string; email: string; role: Role;
  tenant: string; homeCurrency: string; baseCurrency: string;
}

export interface Permissions {
  seesCost: boolean; seesRevenue: boolean; canInvoice: boolean;
  canApproveMilestone: boolean; canManageTeam: boolean;
  isClient: boolean; isAssignedOnly: boolean;
}

export interface Me { user: User; permissions: Permissions | null; isPlatformAdmin: boolean }

export interface Project {
  project_id: string; name: string; client_id: string; client_name: string; country?: string;
  billing_type: 'fixed' | 'hourly' | 'retainer';
  progress: number; hours: number; billable_hours: number;
  starts_on: string; due_on: string | null; status: string;
  contract_value?: number; revenue_base?: number; effective_rate?: number;
  cost_base?: number; cost_home?: number; margin?: number; marginPct?: number;
  burn?: number; budget_cost?: number; projCost?: number; projMargin?: number;
  target_margin?: number; health?: 'good' | 'warn' | 'bad';
}

export interface Milestone {
  id: string; name: string; position: number;
  value_amount: number | null; due_on: string | null; approved_at: string | null;
}

export interface Task {
  id: string; title: string; description: string | null;
  status: 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  position: number; due_on: string | null; estimate_hours: number | null;
  logged_hours: number; project_id: string; project_name: string;
  assignee_id: string | null; assignee_name: string | null; completed_at: string | null;
}

export interface Invoice {
  id: string; number: string; total: number; amount_paid: number; balance: number;
  currency: string; issued_on: string; due_on: string; status: string;
  days_overdue: number; project_id: string | null; project_name?: string;
  client_name: string; last_method?: string | null;
}

export interface Lead {
  id: string; company: string; contact_name: string | null; email: string | null;
  est_value: number; probability: number;
  stage: 'new' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
  next_follow_up: string | null; converted_client: string | null; owner_name: string | null;
}

export interface Quote {
  id: string; number: string; title: string; status: string;
  total: number; currency: string; expires_on: string | null;
  client_name: string; project_id: string | null;
}

export interface Expense {
  id: string; incurred_on: string; description: string; category: string;
  amount: number; amount_base: number; currency: string;
  billable: boolean; status: string; project_id: string | null;
  project_name: string | null; submitted_by: string | null;
}

export interface DocumentRow {
  id: string; filename: string; content_type: string | null; byte_size: number;
  client_visible: boolean; created_at: string; uploaded_by: string | null;
  previewable?: boolean;
  project_id: string | null; client_id: string | null;
}

export interface Notification {
  id: string; kind: string; title: string; body: string | null;
  link: string | null; read_at: string | null; created_at: string;
}

export interface SearchHit { type: string; id: string; label: string; hint?: string; link: string }

export interface Alert {
  lv: 'crit' | 'warn' | 'info'; ic: string; t: string; d: string; project_id?: string;
}

export interface Dashboard {
  portfolio: {
    projects: number; contracted?: number; revenue?: number; cost?: number;
    hours: number; billableHours: number; costHome?: number; quoted?: number;
    projMargin?: number; projCost?: number; realised?: number; effRate?: number;
  };
  hours: { total: number; billable: number; scope: 'company' | 'own' };
  outstanding?: number; overdue?: number;
  projects: Project[]; alerts: Alert[];
  fx: { today: number; ago: number; change: number } | null;
}
