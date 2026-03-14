import { z } from 'zod';

// ─── Base message envelope ────────────────────────────────────────────────────

export const BaseMessageSchema = z.object({
  workflow_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  timestamp: z.number(),
  signature: z.string(),  // HMAC-SHA256 of workflow_id + correlation_id + timestamp
});

// ─── Orchestrator → Agent task messages ──────────────────────────────────────

export const EmailTaskSchema = BaseMessageSchema.extend({
  task: z.literal('draft_campaign'),
  product_ids: z.array(z.string()).optional(),
  campaign_name: z.string(),
  audience_id: z.string(),
  analytics_context: z.object({
    top_products: z.array(z.string()),
    best_send_time: z.string(),
    avg_open_rate: z.number(),
  }).optional(),
  asset_keys: z.array(z.string()).optional(),
});

export const GoogleAdsTaskSchema = BaseMessageSchema.extend({
  task: z.enum(['create_campaign', 'fetch_performance']),
  product_id: z.string().optional(),
  campaign_name: z.string().optional(),
  daily_budget_micros: z.number().optional(),
  keywords: z.array(z.string()).optional(),
});

export const MetaTaskSchema = BaseMessageSchema.extend({
  task: z.enum(['create_campaign', 'fetch_insights']),
  product_id: z.string().optional(),
  campaign_name: z.string().optional(),
  daily_budget: z.number().optional(),
  asset_keys: z.array(z.string()).optional(),
});

export const ContentTaskSchema = BaseMessageSchema.extend({
  task: z.enum(['draft_blog_post', 'draft_product_description']),
  target_keyword: z.string(),
  product_id: z.string().optional(),
  word_count: z.number().default(1200),
});

export const CreativeTaskSchema = BaseMessageSchema.extend({
  task: z.enum(['generate_images']),
  campaign_type: z.enum(['email', 'google_ads', 'meta', 'content']),
  product_ids: z.array(z.string()),
  formats: z.array(z.enum(['1:1', '9:16', '1.91:1', '16:9'])).default(['1:1']),
  style_context: z.string().optional(),
});

export const AnalyticsTaskSchema = BaseMessageSchema.extend({
  task: z.enum(['fetch_email_performance', 'fetch_ads_performance', 'monthly_report']),
  lookback_days: z.number().default(30),
  month: z.string().optional(),  // YYYY-MM for monthly report
});

// ─── Agent → Orchestrator result messages ────────────────────────────────────

export const AgentResultSchema = BaseMessageSchema.extend({
  agent: z.enum(['email', 'google-ads', 'meta', 'content', 'creative', 'analytics']),
  status: z.enum(['success', 'failure', 'partial']),
  data: z.record(z.unknown()),
  error: z.string().optional(),
  approval_id: z.string().optional(),
});

// ─── Approval queue messages ──────────────────────────────────────────────────

export const ApprovalRequestMessageSchema = BaseMessageSchema.extend({
  approval_id: z.string().uuid(),
  agent: z.enum(['email', 'google-ads', 'meta', 'content', 'creative']),
  action_type: z.enum([
    'send_email',
    'enable_google_campaign',
    'activate_meta_campaign',
    'publish_content',
    'increase_budget',
    'create_audience',
  ]),
  payload: z.record(z.unknown()),
  preview_url: z.string().optional(),
  campaign_id: z.string().optional(),
});

// ─── Notification queue messages ─────────────────────────────────────────────

export const NotificationMessageSchema = z.object({
  type: z.enum(['approval_required', 'approval_decided', 'workflow_complete', 'report_ready', 'alert']),
  workflow_id: z.string().uuid().optional(),
  approval_id: z.string().optional(),
  title: z.string(),
  body: z.string(),
  action_url: z.string().optional(),
  severity: z.enum(['info', 'warning', 'critical']).default('info'),
  channels: z.array(z.enum(['slack', 'email'])).default(['slack', 'email']),
});

// ─── Inferred TypeScript types ────────────────────────────────────────────────

export type EmailTask = z.infer<typeof EmailTaskSchema>;
export type GoogleAdsTask = z.infer<typeof GoogleAdsTaskSchema>;
export type MetaTask = z.infer<typeof MetaTaskSchema>;
export type ContentTask = z.infer<typeof ContentTaskSchema>;
export type CreativeTask = z.infer<typeof CreativeTaskSchema>;
export type AnalyticsTask = z.infer<typeof AnalyticsTaskSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type ApprovalRequestMessage = z.infer<typeof ApprovalRequestMessageSchema>;
export type NotificationMessage = z.infer<typeof NotificationMessageSchema>;
