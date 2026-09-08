-- Priority and follow-up flags for arrival/after-hours WhatsApp alerts.
ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS priority BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alert_type TEXT;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS priority BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alert_type TEXT,
  ADD COLUMN IF NOT EXISTS needs_follow_up BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_conversations_priority
  ON public.conversations (priority, last_message_at DESC);
