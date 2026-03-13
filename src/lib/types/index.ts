// ─── Shared domain types ──────────────────────────────────────────────────────

export type AgentName =
  | 'email'
  | 'google-ads'
  | 'meta'
  | 'content'
  | 'creative'
  | 'analytics';

export type WorkflowStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type CampaignStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'active' | 'paused' | 'archived';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type UserRole = 'admin' | 'marketing_manager' | 'marketing_analyst';

export type ActionType =
  | 'send_email'
  | 'enable_google_campaign'
  | 'activate_meta_campaign'
  | 'publish_content'
  | 'increase_budget'
  | 'create_audience';

export interface Workflow {
  id: string;
  type: string;
  status: WorkflowStatus;
  triggered_by: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  metadata: Record<string, unknown>;
}

export interface Campaign {
  id: string;
  workflow_id: string;
  agent: AgentName;
  type: 'email' | 'google_ads' | 'meta' | 'content' | 'creative';
  status: CampaignStatus;
  external_id?: string;   // mailchimp campaign id, google ads campaign id, etc.
  name: string;
  created_at: number;
  metadata: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  workflow_id: string;
  agent: AgentName;
  action_type: ActionType;
  payload: Record<string, unknown>;  // the exact API call to execute on approval
  status: ApprovalStatus;
  requested_at: number;
  decided_at?: number;
  decided_by?: string;
  expires_at: number;
  audit_note?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: number;
}

export interface AuditLogEntry {
  id: string;
  approval_id: string;
  user_id: string;
  role: UserRole;
  decision: 'approved' | 'rejected';
  timestamp: number;
  ip_address?: string;
  user_agent?: string;
}
