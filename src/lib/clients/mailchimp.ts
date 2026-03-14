// Mailchimp Marketing API v3 client
// NOTE: This client intentionally does NOT expose the send or schedule endpoints.
// Only the approval-service is permitted to call those, using its own direct fetch.

export interface MailchimpCampaignCreate {
  type: 'regular';
  recipients: { list_id: string };
  settings: {
    subject_line: string;
    preview_text?: string;
    title: string;
    from_name: string;
    reply_to: string;
  };
}

export interface MailchimpCampaign {
  id: string;
  status: string;
  settings: { subject_line: string; title: string };
  recipients: { list_id: string };
}

export interface MailchimpCampaignContent {
  html: string;
}

export interface MailchimpReport {
  id: string;
  campaign_title: string;
  emails_sent: number;
  opens: { open_rate: number; unique_opens: number };
  clicks: { click_rate: number; unique_subscriber_clicks: number };
  send_time: string;
}

export class MailchimpClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly serverPrefix: string,
    private readonly mock = false
  ) {
    this.baseUrl = `https://${serverPrefix}.api.mailchimp.com/3.0`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.mock) return this.mockResponse<T>(method, path);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const status = response.status;
      throw new Error(`Mailchimp API error ${status} on ${method} ${path}`);
    }

    return response.json() as T;
  }

  async getLists(): Promise<{ lists: Array<{ id: string; name: string }> }> {
    return this.request('GET', '/lists?count=100');
  }

  async createDraftCampaign(campaign: MailchimpCampaignCreate): Promise<MailchimpCampaign> {
    return this.request('POST', '/campaigns', campaign);
  }

  async setCampaignContent(campaignId: string, content: MailchimpCampaignContent): Promise<void> {
    await this.request('PUT', `/campaigns/${campaignId}/content`, content);
  }

  async getCampaign(campaignId: string): Promise<MailchimpCampaign> {
    return this.request('GET', `/campaigns/${campaignId}`);
  }

  async getCampaignReports(count = 50): Promise<{ reports: MailchimpReport[] }> {
    return this.request('GET', `/reports?count=${count}`);
  }

  async getAudienceLists(): Promise<{ lists: Array<{ id: string; name: string; stats: { member_count: number } }> }> {
    return this.request('GET', '/lists');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private mockResponse<T>(_method: string, path: string): T {
    if (path === '/lists') {
      return { lists: [{ id: 'mock-list-id', name: 'Angel Cosmetics Subscribers' }] } as T;
    }
    if (path === '/campaigns') {
      return { id: 'mock-campaign-id', status: 'draft', settings: { subject_line: 'Mock Subject', title: 'Mock Campaign' }, recipients: { list_id: 'mock-list-id' } } as T;
    }
    return {} as T;
  }
}
