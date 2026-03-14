// ApprovalGate Durable Object
// One instance per pending approval — manages 48h TTL via Durable Object alarm()

export class ApprovalGate {
  private state: DurableObjectState;
  private env: { QUEUE_RESULTS?: Queue; DB?: D1Database };

  constructor(state: DurableObjectState, env: { QUEUE_RESULTS?: Queue; DB?: D1Database }) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/set') {
      const body = await request.json() as {
        approval_id: string;
        workflow_id: string;
        ttl_seconds: number;
      };

      await this.state.storage.put('approval_id', body.approval_id);
      await this.state.storage.put('workflow_id', body.workflow_id);

      // Set alarm for TTL expiry
      const expiresAt = Date.now() + body.ttl_seconds * 1000;
      await this.state.storage.setAlarm(expiresAt);

      return new Response(JSON.stringify({ ok: true, expires_at: expiresAt }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/cancel') {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Called by Cloudflare runtime when alarm fires (approval TTL expired)
  async alarm(): Promise<void> {
    const approvalId = await this.state.storage.get<string>('approval_id');
    const workflowId = await this.state.storage.get<string>('workflow_id');

    if (!approvalId) return;

    // Mark approval as expired in D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        "UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'"
      ).bind(approvalId).run();

      // Write audit log entry for expiry
      await this.env.DB.prepare(
        "INSERT INTO audit_log (id, approval_id, user_id, role, decision, timestamp) VALUES (?, ?, 'system', 'admin', 'expired', ?)"
      ).bind(crypto.randomUUID(), approvalId, Math.floor(Date.now() / 1000)).run();
    }

    // Notify results queue about expiry
    if (this.env.QUEUE_RESULTS && workflowId) {
      await this.env.QUEUE_RESULTS.send({
        workflow_id: workflowId,
        correlation_id: crypto.randomUUID(),
        timestamp: Date.now(),
        signature: '',
        agent: 'approval-service',
        status: 'failure',
        data: { approval_id: approvalId, reason: 'expired' },
        error: 'Approval expired after 48 hours',
      });
    }

    await this.state.storage.deleteAll();
  }
}
