// Google Search Console API v1 — read-only

export interface SearchAnalyticsQuery {
  startDate: string;   // YYYY-MM-DD
  endDate: string;
  dimensions: Array<'query' | 'page' | 'country' | 'device'>;
  rowLimit?: number;
  dimensionFilterGroups?: Array<{
    filters: Array<{
      dimension: string;
      operator: 'equals' | 'contains' | 'notContains';
      expression: string;
    }>;
  }>;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class SearchConsoleClient {
  private readonly baseUrl = 'https://searchconsole.googleapis.com/webmasters/v3';

  constructor(
    private readonly siteUrl: string,
    private readonly mock = false
  ) {}

  async query(
    accessToken: string,
    query: SearchAnalyticsQuery
  ): Promise<{ rows: SearchAnalyticsRow[] }> {
    if (this.mock) {
      return {
        rows: [
          { keys: ['angel cosmetics foundation'], clicks: 120, impressions: 3400, ctr: 0.035, position: 8.2 },
          { keys: ['best vegan lipstick'], clicks: 89, impressions: 2100, ctr: 0.042, position: 6.5 },
        ],
      };
    }

    const encodedSite = encodeURIComponent(this.siteUrl);
    const response = await fetch(
      `${this.baseUrl}/sites/${encodedSite}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(query),
      }
    );

    if (!response.ok) {
      throw new Error(`Search Console API error: ${response.status}`);
    }

    return response.json() as Promise<{ rows: SearchAnalyticsRow[] }>;
  }

  async getServiceAccountToken(serviceAccountKey: string): Promise<string> {
    // Parse service account JSON and create JWT for Google OAuth
    const keyData = JSON.parse(serviceAccountKey) as {
      client_email: string;
      private_key: string;
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: keyData.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    // Base64url encode header and payload
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const payloadB64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const signingInput = `${header}.${payloadB64}`;

    // Import RSA private key
    const pemBody = keyData.private_key
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');
    const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(signingInput)
    );

    const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const jwt = `${signingInput}.${sig}`;

    // Exchange JWT for access token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!tokenResponse.ok) throw new Error('Failed to get Search Console access token');
    const data = await tokenResponse.json() as { access_token: string };
    return data.access_token;
  }
}
