// Slack webhook client for approval notifications

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: unknown[];
  action_id?: string;
}

export interface SlackApprovalMessage {
  text: string;
  blocks: SlackBlock[];
}

export class SlackClient {
  constructor(
    private readonly webhookUrl: string,
    private readonly dashboardBaseUrl: string,
    private readonly mock = false
  ) {}

  async sendApprovalNotification(params: {
    approvalId: string;
    workflowId: string;
    agent: string;
    actionType: string;
    summary: string;
    previewUrl?: string;
  }): Promise<void> {
    if (this.mock) {
      console.log(`[MOCK Slack] Approval notification: ${params.summary}`);
      return;
    }

    const approveUrl = `${this.dashboardBaseUrl}/approvals/${params.approvalId}/approve`;
    const rejectUrl = `${this.dashboardBaseUrl}/approvals/${params.approvalId}/reject`;

    const message: SlackApprovalMessage = {
      text: `Action required: ${params.summary}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Angel Cosmetics Marketing — Approval Required' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Agent:* ${params.agent}\n*Action:* ${params.actionType}\n*Summary:* ${params.summary}\n*Workflow:* \`${params.workflowId}\``,
          },
        },
        ...(params.previewUrl ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `<${params.previewUrl}|View Campaign Preview>` },
        }] : []),
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              url: approveUrl,
              action_id: 'approve_action',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              url: rejectUrl,
              action_id: 'reject_action',
            },
          ],
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook error: ${response.status}`);
    }
  }

  async sendNotification(text: string, severity: 'info' | 'warning' | 'critical' = 'info'): Promise<void> {
    if (this.mock) {
      console.log(`[MOCK Slack ${severity}] ${text}`);
      return;
    }

    const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${emoji} ${text}` }),
    });
  }
}
