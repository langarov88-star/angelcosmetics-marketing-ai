// Meta Marketing API v21.0 client
// NOTE: Status ACTIVE is intentionally not exposed. Only approval-service enables ads.

export interface MetaCampaignCreate {
  name: string;
  objective: 'OUTCOME_TRAFFIC' | 'OUTCOME_SALES' | 'OUTCOME_AWARENESS' | 'OUTCOME_ENGAGEMENT';
  status: 'PAUSED';  // Forced — never ACTIVE from agents
  special_ad_categories: string[];
}

export interface MetaAdSetCreate {
  campaign_id: string;
  name: string;
  status: 'PAUSED';
  daily_budget: number;  // in account currency, smallest unit (cents)
  billing_event: 'IMPRESSIONS' | 'LINK_CLICKS';
  optimization_goal: 'LINK_CLICKS' | 'CONVERSIONS' | 'REACH';
  bid_strategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP';
  targeting: {
    age_min: number;
    age_max: number;
    genders?: number[];
    geo_locations: { countries: string[] };
    interests?: Array<{ id: string; name: string }>;
  };
  start_time?: string;
  end_time?: string;
}

export interface MetaAdCreativeCreate {
  name: string;
  object_story_spec: {
    page_id: string;
    link_data: {
      link: string;
      message: string;
      name: string;        // headline
      description: string;
      image_hash?: string;
      call_to_action: {
        type: 'SHOP_NOW' | 'LEARN_MORE' | 'SIGN_UP' | 'GET_OFFER';
      };
    };
  };
}

export interface MetaAdCreate {
  name: string;
  adset_id: string;
  creative: { creative_id: string };
  status: 'PAUSED';
}

export interface MetaInsight {
  campaign_id: string;
  campaign_name: string;
  impressions: string;
  clicks: string;
  spend: string;
  ctr: string;
  actions?: Array<{ action_type: string; value: string }>;
}

export class MetaClient {
  private readonly baseUrl = 'https://graph.facebook.com/v21.0';

  constructor(
    private readonly accessToken: string,
    private readonly adAccountId: string,
    private readonly mock = false
  ) {}

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    if (this.mock) return {} as T;

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('access_token', this.accessToken);

    const response = await fetch(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Meta API error ${response.status} on ${method} ${path}`);
    }

    return response.json() as T;
  }

  async createCampaign(campaign: MetaCampaignCreate): Promise<{ id: string }> {
    if (this.mock) return { id: 'mock-meta-campaign-id' };
    return this.request('POST', `/${this.adAccountId}/campaigns`, campaign as unknown as Record<string, unknown>);
  }

  async createAdSet(adSet: MetaAdSetCreate): Promise<{ id: string }> {
    if (this.mock) return { id: 'mock-meta-adset-id' };
    return this.request('POST', `/${this.adAccountId}/adsets`, adSet as unknown as Record<string, unknown>);
  }

  async createAdCreative(creative: MetaAdCreativeCreate): Promise<{ id: string }> {
    if (this.mock) return { id: 'mock-meta-creative-id' };
    return this.request('POST', `/${this.adAccountId}/adcreatives`, creative as unknown as Record<string, unknown>);
  }

  async createAd(ad: MetaAdCreate): Promise<{ id: string }> {
    if (this.mock) return { id: 'mock-meta-ad-id' };
    return this.request('POST', `/${this.adAccountId}/ads`, ad as unknown as Record<string, unknown>);
  }

  async getInsights(datePreset = 'last_30_days'): Promise<{ data: MetaInsight[] }> {
    if (this.mock) return { data: [] };

    const fields = 'campaign_id,campaign_name,impressions,clicks,spend,ctr,actions';
    return this.request('GET', `/${this.adAccountId}/insights?fields=${fields}&date_preset=${datePreset}`);
  }
}
