/**
 * Shared Type Definitions for Webhook System
 */

// ============================================================================
// Webhook Event Types
// ============================================================================

export type WebhookEventType =
  | 'contact.created'
  | 'contact.updated'
  | 'contact.deleted'
  | 'deal.created'
  | 'deal.updated'
  | 'deal.deleted'
  | 'company.created'
  | 'company.updated'
  | 'company.deleted'
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'note.created'
  | 'note.updated'
  | 'note.deleted'
  | 'activity.created'
  | 'activity.updated'
  | 'activity.deleted'
  | 'test.ping';

export type WebhookAction = 'created' | 'updated' | 'deleted';

export type WebhookTable =
  | 'contacts'
  | 'deals'
  | 'companies'
  | 'tasks'
  | 'notes'
  | 'activities'
  | 'test';

// ============================================================================
// CRM Entity Types
// ============================================================================

export interface Contact {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company_id: number | null;
  title: string | null;
  status: 'new' | 'active' | 'inactive' | 'lead' | 'customer';
  source: string | null;
  avatar_url: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface Deal {
  id: number;
  name: string;
  value: number;
  currency: string;
  stage_id: number;
  contact_id: number | null;
  company_id: number | null;
  expected_close_date: string | null;
  probability: number;
  status: 'open' | 'won' | 'lost';
  lost_reason: string | null;
  notes: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string;
  assigned_to: string | null;
}

export interface Company {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  due_date: string | null;
  completed: boolean;
  completed_at: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  contact_id: number | null;
  deal_id: number | null;
  company_id: number | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface Note {
  id: number;
  content: string;
  contact_id: number | null;
  deal_id: number | null;
  company_id: number | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

// ============================================================================
// Webhook Payload Types
// ============================================================================

export interface WebhookPayload<T = Record<string, unknown>> {
  event: WebhookEventType;
  table: string;
  action: WebhookAction;
  data: T;
  old_data: T | null;
  metadata: WebhookMetadata;
  timestamp: number;
}

export interface WebhookMetadata {
  triggered_at: string;
  transaction_id?: number;
  changed_fields?: string[];
  schema?: string;
  trigger_name?: string;
  test?: boolean;
  [key: string]: unknown;
}

// Typed payload helpers
export type ContactWebhookPayload = WebhookPayload<Contact>;
export type DealWebhookPayload = WebhookPayload<Deal>;
export type CompanyWebhookPayload = WebhookPayload<Company>;
export type TaskWebhookPayload = WebhookPayload<Task>;
export type NoteWebhookPayload = WebhookPayload<Note>;

// ============================================================================
// Webhook Subscription Types
// ============================================================================

export interface WebhookSubscription {
  id: number;
  url: string;
  events: WebhookEventType[];
  secret: string;
  name: string | null;
  description: string | null;
  active: boolean;
  failure_count: number;
  last_triggered_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookLog {
  id: number;
  subscription_id: number;
  event_type: WebhookEventType;
  event_id: string;
  payload: WebhookPayload;
  response_status: number | null;
  response_body: string | null;
  response_headers: Record<string, string> | null;
  attempts: number;
  max_attempts: number;
  success: boolean;
  error_message: string | null;
  error_code: string | null;
  duration_ms: number | null;
  next_retry_at: string | null;
  created_at: string;
  completed_at: string | null;
}

// ============================================================================
// Database Types (for Supabase client)
// ============================================================================

export interface Database {
  public: {
    Tables: {
      webhook_subscriptions: {
        Row: WebhookSubscription;
        Insert: Omit<WebhookSubscription, 'id' | 'created_at' | 'updated_at' | 'failure_count' | 'last_triggered_at' | 'last_success_at' | 'last_failure_at'>;
        Update: Partial<Omit<WebhookSubscription, 'id' | 'user_id' | 'created_at'>>;
      };
      webhook_logs: {
        Row: WebhookLog;
        Insert: Omit<WebhookLog, 'id' | 'created_at'>;
        Update: Partial<Omit<WebhookLog, 'id' | 'subscription_id' | 'created_at'>>;
      };
      webhook_event_queue: {
        Row: {
          id: number;
          event_type: string;
          payload: WebhookPayload;
          status: 'pending' | 'processing' | 'completed' | 'failed';
          attempts: number;
          max_attempts: number;
          created_at: string;
          processed_at: string | null;
          next_attempt_at: string | null;
          error_message: string | null;
        };
        Insert: {
          event_type: string;
          payload: WebhookPayload;
          max_attempts?: number;
        };
        Update: {
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempts?: number;
          processed_at?: string;
          next_attempt_at?: string;
          error_message?: string;
        };
      };
      contacts: {
        Row: Contact;
        Insert: Omit<Contact, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Contact, 'id' | 'created_at' | 'created_by'>>;
      };
      deals: {
        Row: Deal;
        Insert: Omit<Deal, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Deal, 'id' | 'created_at' | 'created_by'>>;
      };
      companies: {
        Row: Company;
        Insert: Omit<Company, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Company, 'id' | 'created_at' | 'created_by'>>;
      };
      tasks: {
        Row: Task;
        Insert: Omit<Task, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Task, 'id' | 'created_at' | 'created_by'>>;
      };
      notes: {
        Row: Note;
        Insert: Omit<Note, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Note, 'id' | 'created_at' | 'created_by'>>;
      };
    };
    Functions: {
      find_matching_subscriptions: {
        Args: { event_type: string };
        Returns: Array<{ id: number; url: string; secret: string; name: string | null }>;
      };
      claim_webhook_events: {
        Args: { batch_size: number };
        Returns: Array<{ id: number; event_type: string; payload: WebhookPayload }>;
      };
      complete_webhook_event: {
        Args: { event_id: number };
        Returns: void;
      };
      fail_webhook_event: {
        Args: { event_id: number; error_msg?: string };
        Returns: void;
      };
      cleanup_old_webhook_logs: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_webhook_queue: {
        Args: { retention_days?: number };
        Returns: number;
      };
      generate_webhook_secret: {
        Args: Record<string, never>;
        Returns: string;
      };
    };
  };
}
