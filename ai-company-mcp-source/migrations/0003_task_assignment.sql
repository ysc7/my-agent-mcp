-- Additive migration: existing tasks remain available to any agent.
ALTER TABLE tasks ADD COLUMN assigned_to TEXT;
