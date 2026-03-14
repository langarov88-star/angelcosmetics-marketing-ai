// Google Ads API v18 client
// Uses REST endpoint (not gRPC) for Cloudflare Workers compatibility
// NOTE: Status ENABLED is intentionally not exposed here. Only approval-service can enable campaigns.

export interface GoogleAdsCampaignCreate {
  name: string;
  status: 'PAUSED';  // Forced — never ENABLED from agents
  advertisingChannelType: 'SEARCH' | 'DISPLAY' | 'SHOPPING';
  campaignBudget: string;  // resource name
  biddingStrategyType: 'TARGET_CPA' | 'MAXIMIZE_CONVERSIONS' | 'MANUAL_CPC';
  dailyBudgetMicros: number;
}

export interface GoogleAdsAdGroup {
  campaign: string;  // resource name
  name: string;
  status: 'PAUSED';
  type: 'SEARCH_STANDARD';
}

export interface ResponsiveSearchAd {
  adGroup: string;  // resource name
  ad: {
    responsiveSearchAd: {
      headlines: Array<{ text: string; pinnedField?: string }>;
      descriptions: Array<{ text: string }>;
      finalUrls: string[];
    };
    finalUrls: string[];
  };
  status: 'PAUSED';
}

export interface CampaignPerformance {
  campaign_id: string;
  campaign_name: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  ctr: number;
}

export class GoogleAdsClient {
  private readonly baseUrl = 'https://googleads.googleapis.com/v18';

  constructor(
    private readonly developerToken: string,
    private readonly customerId: string,
    private readonly mock = false
  ) {}

  private async getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) throw new Error('Failed to refresh Google Ads access token');
    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async createCampaign(
    campaign: GoogleAdsCampaignCreate,
    accessToken: string
  ): Promise<{ resourceName: string }> {
    if (this.mock) return { resourceName: `customers/${this.customerId}/campaigns/mock-123` };

    const response = await fetch(
      `${this.baseUrl}/customers/${this.customerId}/campaigns:mutate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': this.developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operations: [{ create: campaign }],
        }),
      }
    );

    if (!response.ok) throw new Error(`Google Ads createCampaign error: ${response.status}`);
    const data = await response.json() as { results: Array<{ resourceName: string }> };
    return data.results[0];
  }

  async createAdGroup(
    adGroup: GoogleAdsAdGroup,
    accessToken: string
  ): Promise<{ resourceName: string }> {
    if (this.mock) return { resourceName: `customers/${this.customerId}/adGroups/mock-456` };

    const response = await fetch(
      `${this.baseUrl}/customers/${this.customerId}/adGroups:mutate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': this.developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operations: [{ create: adGroup }] }),
      }
    );

    if (!response.ok) throw new Error(`Google Ads createAdGroup error: ${response.status}`);
    const data = await response.json() as { results: Array<{ resourceName: string }> };
    return data.results[0];
  }

  async createResponsiveSearchAd(
    ad: ResponsiveSearchAd,
    accessToken: string
  ): Promise<{ resourceName: string }> {
    if (this.mock) return { resourceName: `customers/${this.customerId}/adGroupAds/mock-789` };

    const response = await fetch(
      `${this.baseUrl}/customers/${this.customerId}/adGroupAds:mutate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': this.developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operations: [{ create: ad }] }),
      }
    );

    if (!response.ok) throw new Error(`Google Ads createAd error: ${response.status}`);
    const data = await response.json() as { results: Array<{ resourceName: string }> };
    return data.results[0];
  }

  async getCampaignPerformance(accessToken: string): Promise<CampaignPerformance[]> {
    if (this.mock) return [];

    const query = `
      SELECT campaign.id, campaign.name,
        metrics.impressions, metrics.clicks,
        metrics.cost_micros, metrics.conversions, metrics.ctr
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
    `;

    const response = await fetch(
      `${this.baseUrl}/customers/${this.customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': this.developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!response.ok) throw new Error(`Google Ads search error: ${response.status}`);
    const data = await response.json() as { results: unknown[] };
    return data.results as CampaignPerformance[];
  }

  async refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string, kvCache: KVNamespace): Promise<string> {
    const cacheKey = `oauth:google-ads:access_token`;
    const cached = await kvCache.get(cacheKey);
    if (cached) return cached;

    const token = await this.getAccessToken(clientId, clientSecret, refreshToken);
    // Cache for 50 minutes (token expires in 60)
    await kvCache.put(cacheKey, token, { expirationTtl: 3000 });
    return token;
  }
}
