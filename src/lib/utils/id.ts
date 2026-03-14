// UUID v4 generation for Cloudflare Workers (no Node.js crypto module needed)

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateWorkflowId(type: string): string {
  return `wf_${type}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

export function generateApprovalId(): string {
  return `appr_${crypto.randomUUID()}`;
}

export function generateCampaignId(agent: string): string {
  return `camp_${agent}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}
