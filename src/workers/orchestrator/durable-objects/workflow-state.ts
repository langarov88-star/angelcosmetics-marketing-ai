// WorkflowState Durable Object
// One instance per workflow type — prevents duplicate concurrent workflows

export class WorkflowState {
  private state: DurableObjectState;
  private activeWorkflows: Map<string, string> = new Map(); // type → workflow_id

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/is-active') {
      const type = url.searchParams.get('type') ?? '';
      const workflowId = await this.state.storage.get<string>(`active:${type}`);

      if (workflowId) {
        return new Response(JSON.stringify({ active: true, workflow_id: workflowId }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ active: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      const body = await request.json() as { workflow_id: string; type: string };
      await this.state.storage.put(`active:${body.type}`, body.workflow_id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/complete') {
      const body = await request.json() as { type: string };
      await this.state.storage.delete(`active:${body.type}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/agent-complete') {
      const body = await request.json() as { workflow_id: string; agent: string };
      const key = `completed:${body.workflow_id}:${body.agent}`;
      await this.state.storage.put(key, true);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
