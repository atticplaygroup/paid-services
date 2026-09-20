-- +migrate Up
CREATE TABLE accounts (
  account_id BIGSERIAL PRIMARY KEY,
  principal VARCHAR(128) NOT NULL UNIQUE,
  balance BIGINT NOT NULL CHECK (balance >= 0),
  create_time TIMESTAMPTZ NOT NULL,
  expire_time TIMESTAMPTZ NOT NULL,
  privilege VARCHAR(10) NOT NULL,
  CHECK (privilege IN ('user', 'admin')),
  -- to prevent timestamp overflow
  CHECK (expire_time < '10000-12-31')
);

CREATE TABLE deposits (
  deposit_id BIGSERIAL PRIMARY KEY,
  transaction_digest VARCHAR(48) NOT NULL UNIQUE,
  epoch BIGINT NOT NULL,
  account_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS used_exchange_tokens (
  token_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE processing_withdrawals (
  processing_withdrawal_id BIGSERIAL PRIMARY KEY,
  transaction_digest TEXT UNIQUE NOT NULL,
  transaction_bcs_type_name TEXT NOT NULL,
  transaction_bcs_bytes BYTEA NOT NULL,
  total_priority_fee BIGINT NOT NULL CHECK(total_priority_fee >= 0),
  withdrawal_status VARCHAR(10) NOT NULL CHECK(withdrawal_status IN ('processing', 'succeeded')),
  create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE withdrawals (
  withdrawal_id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  withdraw_address BYTEA NOT NULL UNIQUE,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  priority_fee BIGINT NOT NULL CHECK (priority_fee >= 0),
  processing_withdrawal_id BIGINT,
  create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Cannot delete account if have pending withdrawals
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (processing_withdrawal_id) REFERENCES processing_withdrawals(processing_withdrawal_id) ON DELETE CASCADE
);

CREATE INDEX ON accounts (principal);
CREATE INDEX ON accounts (create_time);
CREATE INDEX ON accounts (expire_time);

CREATE INDEX ON withdrawals (account_id);
CREATE INDEX ON withdrawals (withdraw_address);
CREATE INDEX ON withdrawals (processing_withdrawal_id);
CREATE INDEX ON withdrawals (priority_fee);
CREATE INDEX ON withdrawals (create_time);

CREATE INDEX ON processing_withdrawals (transaction_digest);
CREATE INDEX ON processing_withdrawals (total_priority_fee);

-- +migrate Down
DROP TABLE withdrawals;
DROP TABLE processing_withdrawals;
DROP TABLE used_exchange_tokens;
DROP TABLE deposits;
DROP TABLE accounts;
