import { z } from 'zod';

/**
 * Validation lives at the boundary. Handlers below this line can assume shapes
 * are correct, which is what stops "hours" arriving as the string "abc" and
 * reaching a numeric column three calls later.
 *
 * Errors come back as a field map rather than a sentence, so the UI can put the
 * message next to the input that caused it.
 */
export function validate(schema, where = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[where]);
    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      return res.status(400).json({
        error: Object.values(fields)[0] || 'That request was not valid',
        fields,
      });
    }
    req[where] = result.data;
    next();
  };
}

const uuid = z.string().uuid('Expected an id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-08-11');

export const schemas = {
  login: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(320),
    password: z.string().min(1, 'Enter your password').max(512),
  }),

  timeEntry: z.object({
    project_id: uuid,
    worked_on: isoDate,
    /* Coerced because number inputs hand back strings — but null, '' and
       undefined are rejected rather than coerced. z.coerce.number() turns all
       three into 0, and 0 hours means "delete this entry" in the handler, so a
       null would have silently destroyed a timesheet row instead of erroring.
       JSON.stringify also renders Infinity and NaN as null, so this is the same
       guard for those. */
    hours: z.preprocess(
      // Only a number or a non-empty string may proceed to coercion. JS will
      // happily give you Number([]) === 0 and Number(null) === 0, and 0 hours
      // means "delete this entry" downstream — so anything that is not clearly
      // a quantity becomes NaN and fails validation instead.
      v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? v : NaN),
      z.coerce.number({ invalid_type_error: 'Hours must be a number' })
        .finite('Hours must be a number')
        .min(0, 'Hours cannot be negative')
        .max(24, 'A day has 24 hours')),
    billable: z.boolean().optional(),
    task_id: uuid.optional().nullable(),
    note: z.string().max(2000).optional(),
  }),

  draftInvoice: z.object({
    project_id: uuid,
    term_days: z.coerce.number().int().min(0).max(365).optional(),
  }),

  settleInvoice: z.object({
    via: z.enum(['wise', 'payoneer', 'bank_wire', 'stripe', 'paypal', 'local_transfer']).optional(),
  }),

  timeQuery: z.object({
    start: isoDate.optional(),
  }),

  idParam: z.object({ id: uuid }),

  payment: z.object({
    amount: z.coerce.number().positive('Enter an amount greater than zero').max(1e9),
    method: z.enum(['bank_transfer','card','cash','wise','payoneer','stripe','paypal','other']),
    received_on: isoDate.optional(),
    reference: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    is_refund: z.boolean().optional(),
  }),

  voidInvoice: z.object({ reason: z.string().min(3, 'Say why').max(500) }),

  task: z.object({
    project_id: uuid,
    title: z.string().trim().min(1, 'Give the task a title').max(200),
    description: z.string().max(5000).optional(),
    assignee_id: uuid.nullable().optional(),
    milestone_id: uuid.nullable().optional(),
    status: z.enum(['backlog','todo','doing','review','done','blocked']).optional(),
    priority: z.enum(['low','medium','high','urgent']).optional(),
    estimate_hours: z.coerce.number().min(0).max(1000).optional(),
    due_on: isoDate.nullable().optional(),
    tags: z.array(z.string().max(40)).max(10).optional(),
  }),

  taskPatch: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    assignee_id: uuid.nullable().optional(),
    status: z.enum(['backlog','todo','doing','review','done','blocked']).optional(),
    priority: z.enum(['low','medium','high','urgent']).optional(),
    estimate_hours: z.coerce.number().min(0).max(1000).nullable().optional(),
    due_on: isoDate.nullable().optional(),
    position: z.coerce.number().int().min(0).max(100000).optional(),
  }).refine(o => Object.keys(o).length > 0, 'Nothing to change'),

  expense: z.object({
    project_id: uuid.nullable().optional(),
    incurred_on: isoDate,
    description: z.string().trim().min(1, 'Describe the expense').max(300),
    category: z.enum(['infrastructure','software','services','travel','hardware','other']),
    amount: z.coerce.number().positive('Enter an amount').max(1e9),
    currency: z.string().length(3).default('USD'),
    billable: z.boolean().optional(),
  }),

  lead: z.object({
    company: z.string().trim().min(1, 'Company name is required').max(200),
    contact_name: z.string().max(160).optional(),
    email: z.string().email('Enter a valid email').max(320).optional().or(z.literal('')),
    phone: z.string().max(60).optional(),
    source: z.enum(['referral','inbound','outbound','event','marketplace','other']).optional(),
    est_value: z.coerce.number().min(0).max(1e9).optional(),
    probability: z.coerce.number().int().min(0).max(100).optional(),
    stage: z.enum(['new','qualified','proposal','negotiation','won','lost']).optional(),
    notes: z.string().max(5000).optional(),
    next_follow_up: isoDate.nullable().optional(),
  }),

  quote: z.object({
    client_id: uuid,
    lead_id: uuid.nullable().optional(),
    title: z.string().trim().min(1, 'Give the quote a title').max(200),
    description: z.string().max(5000).optional(),
    currency: z.string().length(3).default('USD'),
    discount_amount: z.coerce.number().min(0).max(1e9).optional(),
    tax_rate: z.coerce.number().min(0).max(1, 'Tax rate is a fraction, e.g. 0.15').optional(),
    payment_terms: z.string().max(500).optional(),
    expires_on: isoDate.optional(),
    lines: z.array(z.object({
      description: z.string().trim().min(1).max(300),
      quantity: z.coerce.number().positive().max(100000),
      unit_amount: z.coerce.number().min(0).max(1e9),
      is_milestone: z.boolean().optional(),
    })).min(1, 'A quote needs at least one line').max(60),
  }),

  settings: z.object({
    name: z.string().trim().min(1).max(160).optional(),
    legal_name: z.string().max(200).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    tax_id: z.string().max(60).nullable().optional(),
    email: z.string().email().max(320).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    website: z.string().max(200).nullable().optional(),
    invoice_prefix: z.string().max(10).optional(),
    quote_prefix: z.string().max(10).optional(),
    default_tax_rate: z.coerce.number().min(0).max(1, 'Tax rate is a fraction, e.g. 0.15').optional(),
    default_tax_label: z.string().max(60).nullable().optional(),
    payment_terms_days: z.coerce.number().int().min(0).max(365).optional(),
    payment_instructions: z.string().max(1000).nullable().optional(),
    invoice_footer: z.string().max(500).nullable().optional(),
  }).strict('That is not a setting you can change'),

  invite: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(320),
    full_name: z.string().trim().min(1, 'Give their name').max(160),
    role: z.literal('developer', 'New members join as developers').optional(),
    weekly_hours: z.coerce.number().min(0).max(80).optional(),
    cost_amount: z.coerce.number().min(0).max(1e9).optional(),
    bill_rate: z.coerce.number().min(0).max(1e6).optional(),
  }),

  asanaSync: z.object({
    asana_project_gid: z.string().trim().min(1, 'Choose an Asana project').max(60),
    project_id: uuid,
  }),

  quoteDecision: z.object({
    decision: z.enum(['accepted','rejected']),
    reason: z.string().max(500).optional(),
  }),
};
