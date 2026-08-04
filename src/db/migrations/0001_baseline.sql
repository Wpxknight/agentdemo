CREATE TABLE `agent_interactions` (
  `id` varchar(64) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `user_id` varchar(128) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `attempt_id` varchar(64) DEFAULT NULL,
  `turn_no` int DEFAULT NULL,
  `kind` varchar(32) NOT NULL,
  `tool_call_id` varchar(128) DEFAULT NULL,
  `payload` json NOT NULL,
  `status` varchar(32) NOT NULL,
  `resolution` json DEFAULT NULL,
  `resolved_by` varchar(128) DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`tenant_id`,`id`),
  KEY `idx_agent_interactions_pending` (`tenant_id`,`status`,`expires_at`),
  KEY `idx_agent_interactions_run` (`tenant_id`,`run_id`),
  KEY `idx_agent_interactions_turn` (`tenant_id`,`run_id`,`attempt_id`,`turn_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_run_attempts` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `attempt_id` varchar(64) NOT NULL,
  `worker_id` varchar(128) NOT NULL,
  `lease_token` bigint NOT NULL,
  `kernel` varchar(32) NOT NULL,
  `kernel_version` varchar(64) NOT NULL,
  `status` varchar(32) NOT NULL,
  `error_code` varchar(64) DEFAULT NULL,
  `error_message` text,
  `started_at` datetime(3) NOT NULL,
  `completed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`tenant_id`,`run_id`,`attempt_id`),
  KEY `idx_agent_run_attempt_status` (`tenant_id`,`status`,`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_run_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `sequence` bigint NOT NULL,
  `attempt_id` varchar(128) DEFAULT NULL,
  `turn_no` int DEFAULT NULL,
  `kernel` varchar(32) DEFAULT NULL,
  `kernel_version` varchar(64) DEFAULT NULL,
  `correlation_id` varchar(128) DEFAULT NULL,
  `event_type` varchar(64) NOT NULL,
  `node_name` varchar(64) DEFAULT NULL,
  `status` varchar(32) DEFAULT NULL,
  `detail` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_run_event_sequence` (`tenant_id`,`run_id`,`sequence`),
  KEY `idx_agent_run_events_run` (`tenant_id`,`run_id`,`id`),
  KEY `idx_agent_run_events_resume` (`tenant_id`,`run_id`,`sequence`),
  KEY `idx_agent_run_event_attempt` (`tenant_id`,`run_id`,`attempt_id`,`turn_no`),
  KEY `idx_agent_run_event_correlation` (`tenant_id`,`correlation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_run_inbox_messages` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `message_id` varchar(64) NOT NULL,
  `sequence` bigint NOT NULL,
  `idempotency_key` varchar(128) NOT NULL,
  `mode` varchar(16) NOT NULL,
  `message_json` json NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `claim_owner` varchar(128) DEFAULT NULL,
  `claim_token` varchar(64) DEFAULT NULL,
  `claim_expires_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `consumed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`tenant_id`,`run_id`,`message_id`),
  UNIQUE KEY `uq_agent_run_inbox_idempotency` (`tenant_id`,`run_id`,`idempotency_key`),
  UNIQUE KEY `uq_agent_run_inbox_sequence` (`tenant_id`,`run_id`,`sequence`),
  KEY `idx_agent_run_inbox_status` (`tenant_id`,`run_id`,`status`,`sequence`),
  KEY `idx_agent_run_inbox_expiry` (`tenant_id`,`status`,`claim_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_runs` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `user_id` varchar(128) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `kernel` varchar(32) NOT NULL DEFAULT 'pi',
  `kernel_version` varchar(64) NOT NULL DEFAULT '0.82.1',
  `status` varchar(32) NOT NULL DEFAULT 'queued',
  `waiting_reason` varchar(32) DEFAULT NULL,
  `current_node` varchar(64) DEFAULT NULL,
  `step_count` int NOT NULL DEFAULT '0',
  `input_tokens` int NOT NULL DEFAULT '0',
  `output_tokens` int NOT NULL DEFAULT '0',
  `cache_read_tokens` int NOT NULL DEFAULT '0',
  `cache_creation_tokens` int NOT NULL DEFAULT '0',
  `cost_usd` decimal(18,8) DEFAULT NULL,
  `limits_json` json DEFAULT NULL,
  `execution_json` json DEFAULT NULL,
  `error_message` text,
  `started_at` datetime(3) DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) DEFAULT NULL,
  `cancel_requested_at` datetime(3) DEFAULT NULL,
  `lease_owner` varchar(128) DEFAULT NULL,
  `lease_token` bigint NOT NULL DEFAULT '0',
  `lease_expires_at` datetime(3) DEFAULT NULL,
  `append_closed_at` datetime(3) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`run_id`),
  KEY `idx_agent_runs_session` (`tenant_id`,`user_id`,`session_id`,`created_at`),
  KEY `idx_agent_runs_status` (`tenant_id`,`status`,`updated_at`),
  KEY `idx_agent_runs_lease` (`lease_expires_at`),
  KEY `idx_agent_runs_session_status` (`tenant_id`,`session_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_tool_executions` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `attempt_id` varchar(64) DEFAULT NULL,
  `turn_no` int DEFAULT NULL,
  `session_id` varchar(128) NOT NULL,
  `tool_call_id` varchar(128) NOT NULL,
  `logical_call_id` varchar(128) NOT NULL,
  `idempotency_key` varchar(255) NOT NULL,
  `capability` varchar(32) NOT NULL DEFAULT 'non_idempotent_write',
  `external_correlation_id` varchar(255) DEFAULT NULL,
  `result_digest` char(64) DEFAULT NULL,
  `approved_interaction_id` varchar(64) DEFAULT NULL,
  `tool_name` varchar(255) NOT NULL,
  `args_digest` char(64) NOT NULL,
  `status` varchar(32) NOT NULL,
  `result` json DEFAULT NULL,
  `started_at` timestamp NOT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`run_id`,`tool_call_id`),
  UNIQUE KEY `uq_agent_tool_logical_call` (`tenant_id`,`run_id`,`logical_call_id`),
  KEY `idx_agent_tool_recovery` (`tenant_id`,`status`,`updated_at`),
  KEY `idx_agent_tool_external_correlation` (`tenant_id`,`external_correlation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_turn_commits` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `attempt_id` varchar(64) NOT NULL,
  `turn_no` int NOT NULL,
  `pi_session_id` varchar(128) DEFAULT NULL,
  `pi_leaf_id` varchar(64) DEFAULT NULL,
  `pi_entry_seq` bigint DEFAULT NULL,
  `commit_id` varchar(64) NOT NULL,
  `transcript_version` bigint NOT NULL,
  `stop_reason` varchar(64) DEFAULT NULL,
  `usage_json` json NOT NULL,
  `messages_json` json NOT NULL,
  `event_sequence_end` bigint NOT NULL,
  `committed_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`,`run_id`,`attempt_id`,`turn_no`),
  UNIQUE KEY `uq_agent_turn_commit_id` (`commit_id`),
  KEY `idx_agent_turn_commit_run` (`tenant_id`,`run_id`,`transcript_version`),
  KEY `idx_agent_turn_pi_session` (`tenant_id`,`pi_session_id`,`pi_entry_seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `agent_turn_snapshots` (
  `tenant_id` varchar(64) NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `attempt_id` varchar(64) NOT NULL,
  `turn_no` int NOT NULL,
  `session_version` bigint NOT NULL,
  `parent_commit_id` varchar(64) DEFAULT NULL,
  `identity_json` json NOT NULL,
  `model_binding_json` json NOT NULL,
  `prompt_version` varchar(128) NOT NULL,
  `skill_set_version` varchar(128) DEFAULT NULL,
  `tool_set_version` varchar(128) NOT NULL,
  `policy_version` varchar(128) NOT NULL,
  `limits_json` json DEFAULT NULL,
  `messages_json` json NOT NULL,
  `deadline_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`,`run_id`,`attempt_id`,`turn_no`),
  KEY `idx_agent_turn_snapshot_run` (`tenant_id`,`run_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `audit_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tenant_id` varchar(64) DEFAULT NULL,
  `kind` varchar(16) NOT NULL,
  `action` varchar(32) NOT NULL,
  `session_id` varchar(128) DEFAULT NULL,
  `cluster` varchar(128) DEFAULT NULL,
  `tool` varchar(64) DEFAULT NULL,
  `detail` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_session` (`tenant_id`,`session_id`,`id`),
  KEY `idx_audit_kind` (`tenant_id`,`kind`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tenant_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `role` varchar(16) NOT NULL,
  `content` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `user_id` varchar(64) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_messages_session` (`tenant_id`,`session_id`,`id`),
  KEY `idx_messages_tenant_id` (`tenant_id`,`id`),
  KEY `idx_messages_session_user` (`tenant_id`,`user_id`,`session_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `pi_session_entries` (
  `tenant_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `entry_id` varchar(64) NOT NULL,
  `entry_seq` bigint NOT NULL,
  `parent_id` varchar(64) DEFAULT NULL,
  `entry_type` varchar(32) NOT NULL,
  `entry_json` json NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`,`session_id`,`entry_id`),
  UNIQUE KEY `uq_pi_session_entry_seq` (`tenant_id`,`session_id`,`entry_seq`),
  KEY `idx_pi_session_entry_parent` (`tenant_id`,`session_id`,`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `pi_sessions` (
  `tenant_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `current_leaf_id` varchar(64) DEFAULT NULL,
  `committed_leaf_id` varchar(64) DEFAULT NULL,
  `metadata_json` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`,`session_id`),
  KEY `idx_pi_sessions_updated` (`tenant_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `scheduled_tasks` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tenant_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `title` varchar(200) NOT NULL DEFAULT '',
  `cron` varchar(128) NOT NULL,
  `task` text NOT NULL,
  `pre_approved` tinyint(1) NOT NULL DEFAULT '0',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `next_run_at` timestamp NOT NULL,
  `last_run_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_due` (`enabled`,`next_run_at`),
  KEY `idx_tenant` (`tenant_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `scheduler_fires` (
  `fire_id` varchar(255) NOT NULL,
  `task_id` bigint NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `actor_id` varchar(128) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `fire_time` datetime(3) NOT NULL,
  `input_json` json NOT NULL,
  `state` varchar(16) NOT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `run_id` varchar(128) DEFAULT NULL,
  `claim_token` varchar(64) DEFAULT NULL,
  `claim_owner` varchar(128) DEFAULT NULL,
  `lease_expires_at` datetime(3) DEFAULT NULL,
  `retry_at` datetime(3) DEFAULT NULL,
  `last_error` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`fire_id`),
  KEY `idx_scheduler_fires_claim` (`state`,`retry_at`,`fire_time`),
  KEY `idx_scheduler_fires_lease` (`state`,`lease_expires_at`),
  KEY `idx_scheduler_fires_task` (`tenant_id`,`task_id`,`fire_time`),
  KEY `idx_scheduler_fires_run` (`tenant_id`,`run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sessions` (
  `tenant_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `title` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `user_id` varchar(64) NOT NULL DEFAULT '',
  PRIMARY KEY (`tenant_id`,`user_id`,`session_id`),
  KEY `idx_sessions_updated` (`tenant_id`,`updated_at`),
  KEY `idx_sessions_tenant_user` (`tenant_id`,`user_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `setting_secrets` (
  `tenant_id` varchar(64) NOT NULL,
  `setting_key` varchar(64) NOT NULL,
  `payload` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `task_agent_runs` (
  `tenant_id` varchar(64) NOT NULL,
  `task_id` bigint NOT NULL,
  `run_id` varchar(128) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`,`task_id`,`run_id`),
  KEY `idx_task_agent_runs_run` (`tenant_id`,`run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `task_runs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `task_id` bigint NOT NULL,
  `fire_id` varchar(255) DEFAULT NULL,
  `run_id` varchar(128) DEFAULT NULL,
  `status` varchar(16) NOT NULL,
  `detail` text,
  `steps` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_task_runs_fire` (`fire_id`),
  KEY `idx_runs_task` (`task_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `tenant_settings` (
  `tenant_id` varchar(64) NOT NULL,
  `setting_key` varchar(64) NOT NULL,
  `config` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `tenants` (
  `id` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_credentials` (
  `tenant_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `payload` text NOT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`user_id`,`provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` varchar(64) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `username` varchar(128) NOT NULL,
  `role` varchar(32) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `auth_provider` varchar(16) NOT NULL DEFAULT 'local',
  `display_name` varchar(128) DEFAULT NULL,
  `home_dir` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user` (`tenant_id`,`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

