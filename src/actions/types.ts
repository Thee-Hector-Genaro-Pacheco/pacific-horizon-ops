import { z } from 'zod';

export const ActionStatusSchema = z.enum([
  'RECEIVED',
  'CLASSIFIED',
  'DRAFTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTED',
  'FAILED',
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ActionTypeSchema = z.enum([
  'CREATE_EMAIL_DRAFT',
  'SEND_EMAIL',
  'CREATE_CALENDAR_EVENT',
  'SEND_SMS',
  'PLACE_VOICE_CALL',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ApprovalSourceSchema = z.enum(['cli', 'dashboard', 'voice']);
export type ApprovalSource = z.infer<typeof ApprovalSourceSchema>;

export const ApprovalRecordSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approvedBy: z.string(),
  approvedAt: z.string(),
  approvalSource: ApprovalSourceSchema,
  notes: z.string().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ProposedActionSchema = z.object({
  type: ActionTypeSchema,
  description: z.string(),
  payload: z.record(z.unknown()),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ExecutionMetadataSchema = z.object({
  executedAt: z.string(),
  executor: z.string(),
  result: z.record(z.unknown()).optional(),
});
export type ExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;

export const ActionRecordSchema = z.object({
  actionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageId: stringOrEmpty(z.string()),
  threadId: stringOrEmpty(z.string()),
  draftId: z.string().nullable(),
  actionType: ActionTypeSchema,
  status: ActionStatusSchema,
  subject: z.string(),
  from: z.string(),
  classificationCategory: z.string(),
  confidence: z.number().min(0).max(1),
  proposedAction: ProposedActionSchema,
  approvalMetadata: ApprovalRecordSchema.nullable(),
  executionMetadata: ExecutionMetadataSchema.nullable(),
  failureReason: z.string().nullable(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

function stringOrEmpty(schema: z.ZodString) {
  return schema;
}

export const ActionEventSchema = z.object({
  eventId: z.string(),
  actionId: z.string(),
  timestamp: z.string(),
  fromStatus: ActionStatusSchema.nullable(),
  toStatus: ActionStatusSchema,
  actor: z.string(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ActionEvent = z.infer<typeof ActionEventSchema>;
