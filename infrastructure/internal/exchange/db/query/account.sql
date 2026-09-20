-- name: UpsertAccount :one
INSERT INTO accounts (
  principal,
  balance,
  privilege,
  create_time,
  expire_time
) VALUES (
  @principal, @balance, @privilege, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + @ttl::interval
)
ON CONFLICT (principal) DO UPDATE SET
  balance = accounts.balance + EXCLUDED.balance,
  expire_time = accounts.expire_time + @ttl::interval
RETURNING *
;

-- name: DeleteInvalidAccounts :many
DELETE FROM accounts
WHERE
  expire_time < CURRENT_TIMESTAMP
RETURNING account_id
;

-- name: ChangeBalance :one
UPDATE accounts
SET balance = balance + @balance_change
WHERE principal = @principal
RETURNING *
;

-- name: GetAccount :one
SELECT
  *
FROM accounts
WHERE principal = @principal
;

-- name: QueryBalanceForShare :one
SELECT *
FROM accounts
WHERE principal = @principal
AND expire_time > CURRENT_TIMESTAMP
FOR SHARE
;

-- name: QueryBalance :one
SELECT *
FROM accounts
WHERE principal = @principal
AND expire_time > CURRENT_TIMESTAMP
;

-- name: AddDepositRecord :one
INSERT INTO deposits (
  transaction_digest,
  epoch,
  account_id
) VALUES (
  $1, $2, $3
)
RETURNING *
;

-- name: LockAccountByPrincipal :one
SELECT account_id
FROM accounts
WHERE principal = @principal
FOR UPDATE
;

-- name: InsertAccount :one
INSERT INTO accounts (
  principal,
  balance,
  privilege,
  create_time,
  expire_time
) VALUES (
  @principal, @balance, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + @ttl::interval
)
RETURNING account_id
;

-- name: UpdateAccountBalance :exec
UPDATE accounts
SET
  balance = balance + @balance_change,
  expire_time = expire_time + @ttl::interval
WHERE account_id = @account_id
;

-- name: ExtendAccountExpiry :exec
UPDATE accounts
SET expire_time = CURRENT_TIMESTAMP + @ttl::interval
WHERE principal = @principal
AND expire_time > CURRENT_TIMESTAMP
;

-- name: DeductBalance :one
UPDATE accounts
SET balance = balance + @balance_change
WHERE principal = @principal
AND expire_time > CURRENT_TIMESTAMP
AND balance + @balance_change >= 0
RETURNING balance
;

-- name: DeleteAccountByPrincipal :execrows
DELETE FROM accounts
WHERE principal = @principal
;
