ALTER TABLE `scheduled_tasks`
  ADD COLUMN IF NOT EXISTS `timezone` varchar(64) NOT NULL DEFAULT 'UTC' AFTER `cron`,
  ADD COLUMN IF NOT EXISTS `deleted_at` datetime(3) DEFAULT NULL AFTER `enabled`;

ALTER TABLE `scheduled_tasks`
  DROP INDEX IF EXISTS `idx_due`,
  ADD INDEX IF NOT EXISTS `idx_due` (`enabled`, `deleted_at`, `next_run_at`);

ALTER TABLE `scheduler_fires`
  ADD COLUMN IF NOT EXISTS `trigger_kind` varchar(16) NOT NULL DEFAULT 'cron' AFTER `input_json`,
  ADD COLUMN IF NOT EXISTS `idempotency_key` varchar(128) DEFAULT NULL AFTER `trigger_kind`,
  ADD INDEX IF NOT EXISTS `idx_scheduler_fires_task_history` (`tenant_id`, `task_id`, `fire_time`, `fire_id`),
  ADD INDEX IF NOT EXISTS `idx_scheduler_fires_retention` (`state`, `updated_at`),
  ADD UNIQUE INDEX IF NOT EXISTS `uq_scheduler_fires_manual_idempotency`
    (`tenant_id`, `task_id`, `trigger_kind`, `idempotency_key`);

UPDATE `scheduler_fires`
SET `state` = 'completed'
WHERE `state` = 'started';
