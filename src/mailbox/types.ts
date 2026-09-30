import { z } from 'zod';

export const MailboxCategorySchema = z.enum([
  'PROMOTION',
  'NEWSLETTER',
  'SOCIAL_NOTIFICATION',
  'LARGE_MESSAGE',
  'RECEIPT',
  'ORDER_CONFIRMATION',
  'SHIPPING_CONFIRMATION',
  'REFUND_CONFIRMATION',
  'ACCOUNT_SECURITY',
  'FINANCIAL',
  'LEGAL',
  'GOVERNMENT',
  'PERSONAL',
  'UNKNOWN',
]);
export type MailboxCategory = z.infer<typeof MailboxCategorySchema>;

export const ProtectionFlagSchema = z.enum([
  'RECEIPT_LIKE',
  'FINANCIAL_LIKE',
  'SECURITY_LIKE',
  'GOVERNMENT_LIKE',
  'LEGAL_LIKE',
  'PURCHASE_LIKE',
  'UNKNOWN_CONTENT',
]);
export type ProtectionFlag = z.infer<typeof ProtectionFlagSchema>;

export const RecommendedActionSchema = z.enum(['RECOMMEND_TRASH', 'KEEP_REVIEW']);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

export const PlanStatusSchema = z.enum([
  'CREATED',
  'REVIEW_REQUIRED',
  'APPROVED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const CandidateExecutionStatusSchema = z.enum([
  'PENDING',
  'TRASHED',
  'SKIPPED',
  'FAILED',
]);
export type CandidateExecutionStatus = z.infer<typeof CandidateExecutionStatusSchema>;

export const MailboxCleanupCandidateSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  sender: z.string(),
  subject: z.string(),
  date: z.string(),
  category: MailboxCategorySchema,
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  estimatedSize: z.number().nullable(),
  protectionFlags: z.array(ProtectionFlagSchema),
  recommendedAction: RecommendedActionSchema,
  executionStatus: CandidateExecutionStatusSchema.optional(),
  executionReason: z.string().optional(),
});
export type MailboxCleanupCandidate = z.infer<typeof MailboxCleanupCandidateSchema>;

export const MailboxProtectedMessageSchema = MailboxCleanupCandidateSchema;
export type MailboxProtectedMessage = MailboxCleanupCandidate;

export const MailboxCleanupPlanSchema = z.object({
  id: z.string(),
  gmailAccount: z.string(),
  gmailProfile: z.enum(['business', 'personal']).optional(),
  createdAt: z.string(),
  query: z.string(),
  status: PlanStatusSchema,
  candidateCount: z.number(),
  totalEstimatedBytes: z.number().nullable(),
  candidates: z.array(MailboxCleanupCandidateSchema),
  excludedCount: z.number(),
  excluded: z.array(MailboxProtectedMessageSchema).optional(),
  approvedAt: z.string().optional(),
  approvedBy: z.string().optional(),
  executedAt: z.string().optional(),
  failure: z.string().optional(),
});
export type MailboxCleanupPlan = z.infer<typeof MailboxCleanupPlanSchema>;

export const MailboxCleanupEventSchema = z.object({
  eventId: z.string(),
  planId: z.string(),
  timestamp: z.string(),
  fromStatus: PlanStatusSchema.nullable(),
  toStatus: PlanStatusSchema,
  actor: z.string(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type MailboxCleanupEvent = z.infer<typeof MailboxCleanupEventSchema>;
