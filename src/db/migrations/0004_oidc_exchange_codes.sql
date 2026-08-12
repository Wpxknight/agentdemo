CREATE TABLE IF NOT EXISTS `oidc_exchange_codes` (
  `code_hash` char(64) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `provider` varchar(16) NOT NULL,
  `session_token` text NOT NULL,
  `browser_nonce_hash` char(64) DEFAULT NULL,
  `expires_at` datetime(3) NOT NULL,
  `consumed_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`code_hash`),
  KEY `idx_oidc_exchange_expiry` (`expires_at`),
  KEY `idx_oidc_exchange_consumed_expiry` (`consumed_at`,`expires_at`),
  KEY `idx_oidc_exchange_tenant` (`tenant_id`,`provider`,`consumed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `oidc_exchange_codes`
  ADD INDEX IF NOT EXISTS `idx_oidc_exchange_expiry` (`expires_at`),
  ADD INDEX IF NOT EXISTS `idx_oidc_exchange_consumed_expiry` (`consumed_at`,`expires_at`);
