package store_test

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/jackc/pgx/v5/pgtype"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Record withdrawal and set at waiting status", Label("db"), func() {
	Context("with positive deposit", Ordered, func() {
		var withdrawalId *int64
		var processingWithdrawId *int64
		var account *db.Account
		ctx := context.Background()
		s := *StoreInstance

		BeforeAll(func() {
			RefreshDb(StoreTestDb, Migrations)
			var err error
			account, err = s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhpJ",
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: "test_user_1",
					Balance:   1_000_000,
					Ttl: pgtype.Interval{
						Microseconds: 3600 * 24 * 30 * 1000,
						Valid:        true,
					},
					Privilege: "user",
				},
			})
			if err != nil {
				Fail(fmt.Sprintf("Failed to deposit: %v", err))
			}
		})

		withdrawToAddress := func(chainAddress string) (*int64, error) {
			chainAddressBytes, err := hex.DecodeString(chainAddress[2:])
			if err != nil {
				log.Fatalf("Failed to decode hex string: %v", err)
			}
			withdrawTxParams := store.WithdrawTxParams{
				StartWithdrawalParams: db.StartWithdrawalParams{
					Principal:       account.Principal,
					WithdrawAddress: chainAddressBytes,
					Amount:          500_000,
					PriorityFee:     100_000,
				},
				WithdrawAll: false,
			}
			withdrawal, err := s.WithdrawTx(ctx, withdrawTxParams)
			if err != nil {
				return nil, err
			}
			return &withdrawal.WithdrawalID, nil
		}

		When("user withdraws with proper amount", func() {
			It("should record the withdrawal in waiting status", func() {
				chainAddress := "0xe789fb3f9e6e0736b648f3f33ff60bc0e4583583b2142cb2665bcc520635aac0"
				accountBefore, err := s.QueryBalance(ctx, account.Principal)
				balanceBefore := accountBefore.Balance
				Expect(err).To(BeNil())

				withdrawalId, err = withdrawToAddress(chainAddress)
				Expect(err).To(BeNil())

				accountAfter, err := s.QueryBalance(ctx, account.Principal)
				balanceAfter := accountAfter.Balance
				Expect(err).To(BeNil())
				Expect(balanceBefore - balanceAfter).To(BeEquivalentTo(600_000))

				withdrawals, err := s.ListWithdrawals(ctx, db.ListWithdrawalsParams{
					Limit:     2,
					Offset:    0,
					AccountID: account.AccountID,
				})

				Expect(err).To(BeNil())
				Expect(withdrawals).To(HaveLen(1))
				Expect(withdrawals[0].WithdrawalID).To(Equal(*withdrawalId))
				Expect(withdrawals[0].ProcessingWithdrawalID.Valid).To(Not(BeTrue()))
			})

			When("withdraw to the same address before canceling", func() {
				It("should fail to withdraw", func() {
					chainAddress := "0xe789fb3f9e6e0736b648f3f33ff60bc0e4583583b2142cb2665bcc520635aac0"
					_, err := withdrawToAddress(chainAddress)
					Expect(err).To(MatchError(ContainSubstring(
						"duplicate key value violates unique constraint \"withdrawals_withdraw_address_key\"",
					)))
				})
			})

			When("withdraw another address but insufficient balance", func() {
				It("should fail to withdraw", func() {
					chainAddress := "0x4f89910d450a3654e82bc3f573e24dfcbbeed23cb3b87de4883e890bfd952473"
					_, err := withdrawToAddress(chainAddress)
					Expect(err).To(MatchError(ContainSubstring(
						"violates check constraint \"accounts_balance_check\"",
					)))
				})
			})
		})

		When("user then cancels the withdrawal request", func() {
			It("should success", func() {
				err := s.CancelWithdrawTx(ctx, store.CancelWithdrawTxParams{
					WithdrawalId: *withdrawalId,
					Principal:    account.Principal,
				})
				Expect(err).To(BeNil())

				account, err := s.QueryBalance(ctx, account.Principal)
				Expect(err).To(BeNil())
				Expect(account.Balance).To(BeEquivalentTo(1_000_000))
			})
		})

		transactionDigest := "CeVpDXKKU3Gs89efej9pKiYYQyTzifE2BDxWwquUaUht"

		When("user withdraw again and got processed", func() {
			It("should have withdrawal record in processing status", func() {
				chainAddress := "0x4f89910d450a3654e82bc3f573e24dfcbbeed23cb3b87de4883e890bfd952473"
				var err error
				withdrawalId, err = withdrawToAddress(chainAddress)
				Expect(err).To(BeNil())

				processingWithdrawal, err := s.SetWithdrawalBatch(
					ctx, db.SetWithdrawalBatchParams{
						TransactionDigest:      transactionDigest,
						TransactionBcsTypeName: "transaction",
						TransactionBcsBytes:    []byte("m0ck"),
						TotalPriorityFee:       100,
					})
				processingWithdrawId = &processingWithdrawal.ProcessingWithdrawalID
				Expect(err).To(BeNil())
				withdraws, err := s.ProcessWithdrawals(ctx, db.ProcessWithdrawalsParams{
					ProcessingWithdrawalID: pgtype.Int8{
						Int64: processingWithdrawal.ProcessingWithdrawalID,
						Valid: true,
					},
					WithdrawalIds: []int64{*withdrawalId},
				})
				Expect(err).To(BeNil())
				Expect(withdraws).To(HaveLen(1))
				Expect(withdraws[0].WithdrawalID).To(Equal(*withdrawalId))
				Expect(withdraws[0].Amount).To(BeEquivalentTo(500_000))
				Expect(withdraws[0].ProcessingWithdrawalID.Value()).To(
					BeEquivalentTo(*processingWithdrawId))
			})
		})

		When("user cancels withdrawal but all are not in waiting status", func() {
			It("should fail to cancel", func() {
				err := s.CancelWithdrawTx(ctx, store.CancelWithdrawTxParams{
					WithdrawalId: *withdrawalId,
					Principal:    account.Principal,
				})
				Expect(err).To(MatchError(ContainSubstring("no rows in result set")))

				account, err := s.QueryBalance(ctx, account.Principal)
				Expect(err).To(BeNil())
				Expect(account.Balance).To(BeEquivalentTo(400_000))
			})
		})

		When("successful processed withdrawals are removed", func() {
			It("should also delete in withdrawls", func() {
				succeedWithdrawal, err := s.SetWithdrawalSuccess(ctx, transactionDigest)
				Expect(err).To(BeNil())
				Expect(succeedWithdrawal.ProcessingWithdrawalID).To(BeEquivalentTo(
					*processingWithdrawId,
				))
				withdrawIds, err := s.CleanOldWithdrawals(
					ctx, pgtype.Timestamptz{
						Time:  time.Now().Add(5 * time.Second),
						Valid: true,
					})
				Expect(err).To(BeNil())
				Expect(withdrawIds).To(HaveLen(1))
				Expect(withdrawIds[0].ProcessingWithdrawalID).To(
					BeEquivalentTo(*processingWithdrawId))

				withdrawals, err := s.ListWithdrawals(ctx, db.ListWithdrawalsParams{
					Limit:  100,
					Offset: 0,
				})
				Expect(err).To(BeNil())
				Expect(len(withdrawals)).To(BeEquivalentTo(0))
			})
		})
	})
})

var _ = Describe("Batch withdrawal for multiple sellers", Label("db"), func() {
	It("processes and completes withdrawals for multiple sellers", func() {
		ctx := context.Background()
		s := *StoreInstance
		RefreshDb(StoreTestDb, Migrations)

		const depositAmount = 700
		const withdrawalAmount = 300
		const priorityFee = 20
		sellers := make([]*db.Account, 2)
		addresses := []string{
			"0x1111111111111111111111111111111111111111111111111111111111111111",
			"0x2222222222222222222222222222222222222222222222222222222222222222",
		}
		withdrawalIds := make([]int64, len(sellers))
		for index := range sellers {
			seller, err := s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: fmt.Sprintf("batch-withdraw-seller-%d", index),
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: fmt.Sprintf("http://batch-seller-%d.example", index),
					Balance:   depositAmount,
					Ttl:       pgtype.Interval{Microseconds: 3600 * 24 * 1000, Valid: true},
					Privilege: "user",
				},
			})
			Expect(err).To(BeNil())
			sellers[index] = seller

			address, err := hex.DecodeString(addresses[index][2:])
			Expect(err).To(BeNil())
			withdrawal, err := s.WithdrawTx(ctx, store.WithdrawTxParams{
				StartWithdrawalParams: db.StartWithdrawalParams{
					Principal:       seller.Principal,
					WithdrawAddress: address,
					Amount:          withdrawalAmount,
					PriorityFee:     priorityFee,
				},
			})
			Expect(err).To(BeNil())
			withdrawalIds[index] = withdrawal.WithdrawalID
		}

		processing, err := s.SetWithdrawalBatch(ctx, db.SetWithdrawalBatchParams{
			TransactionDigest:      "batch-withdraw-digest",
			TransactionBcsTypeName: "transaction",
			TransactionBcsBytes:    []byte("batch"),
			TotalPriorityFee:       int64(priorityFee) * int64(len(sellers)),
		})
		Expect(err).To(BeNil())
		processed, err := s.ProcessWithdrawals(ctx, db.ProcessWithdrawalsParams{
			ProcessingWithdrawalID: pgtype.Int8{
				Int64: processing.ProcessingWithdrawalID,
				Valid: true,
			},
			WithdrawalIds: withdrawalIds,
		})
		Expect(err).To(BeNil())
		Expect(processed).To(HaveLen(2))
		for index, seller := range sellers {
			Expect(processed[index].WithdrawalID).To(Equal(withdrawalIds[index]))
			Expect(processed[index].AccountID).To(Equal(seller.AccountID))
			balance, err := s.QueryBalance(ctx, seller.Principal)
			Expect(err).To(BeNil())
			Expect(balance.Balance).To(Equal(int64(depositAmount - withdrawalAmount - priorityFee)))
		}

		completed, err := s.SetWithdrawalSuccess(ctx, "batch-withdraw-digest")
		Expect(err).To(BeNil())
		Expect(completed.ProcessingWithdrawalID).To(Equal(processing.ProcessingWithdrawalID))
		Expect(completed.WithdrawalStatus).To(Equal("succeeded"))
	})
})

var _ = Describe("Withdrawal priority and retention lifecycle", Label("db"), func() {
	It("batches the highest waiting fees and cleans completed batches without removing waiting or processing withdrawals", func() {
		ctx := context.Background()
		s := StoreInstance
		RefreshDb(StoreTestDb, Migrations)

		fees := []int64{3_000_000, 2_000_000, 1_000_000, 1_500_000}
		withdrawals := make([]*db.Withdrawal, len(fees))
		for index, fee := range fees {
			principal := fmt.Sprintf("withdrawal-lifecycle-seller-%d", index)
			_, err := s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: fmt.Sprintf("withdrawal-lifecycle-deposit-%d", index),
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: principal,
					Balance:   20_000_000,
					Ttl:       pgtype.Interval{Microseconds: 24 * 3600 * 1_000_000, Valid: true},
					Privilege: "user",
				},
			})
			Expect(err).NotTo(HaveOccurred())
			address := make([]byte, 32)
			address[31] = byte(index + 1)
			withdrawals[index], err = s.WithdrawTx(ctx, store.WithdrawTxParams{
				StartWithdrawalParams: db.StartWithdrawalParams{
					Principal:       principal,
					WithdrawAddress: address,
					Amount:          10_000_000,
					PriorityFee:     fee,
				},
			})
			Expect(err).NotTo(HaveOccurred())
			balance, err := s.QueryBalance(ctx, principal)
			Expect(err).NotTo(HaveOccurred())
			Expect(balance.Balance).To(Equal(10_000_000 - fee))
		}

		// The second seller's earlier batch is already complete and must not
		// compete with waiting withdrawals, despite its higher fee.
		previous, err := s.SetWithdrawalBatch(ctx, db.SetWithdrawalBatchParams{
			TransactionDigest: "previous-withdrawal-batch", TransactionBcsTypeName: "transaction",
			TransactionBcsBytes: []byte("previous"), TotalPriorityFee: fees[1],
		})
		Expect(err).NotTo(HaveOccurred())
		_, err = s.ProcessWithdrawals(ctx, db.ProcessWithdrawalsParams{
			ProcessingWithdrawalID: pgtype.Int8{Int64: previous.ProcessingWithdrawalID, Valid: true},
			WithdrawalIds:          []int64{withdrawals[1].WithdrawalID},
		})
		Expect(err).NotTo(HaveOccurred())
		_, err = s.SetWithdrawalSuccess(ctx, previous.TransactionDigest)
		Expect(err).NotTo(HaveOccurred())

		tx, err := s.GetConn().Begin(ctx)
		Expect(err).NotTo(HaveOccurred())
		defer func() { _ = tx.Rollback(ctx) }()
		qtx := s.WithTx(tx)
		candidates, err := qtx.SelectCandidateWithdrawals(ctx, 2)
		Expect(err).NotTo(HaveOccurred())
		Expect(candidates).To(HaveLen(2))
		Expect(candidates[0].WithdrawalID).To(Equal(withdrawals[0].WithdrawalID))
		Expect(candidates[1].WithdrawalID).To(Equal(withdrawals[3].WithdrawalID))
		batch, err := qtx.SetWithdrawalBatch(ctx, db.SetWithdrawalBatchParams{
			TransactionDigest: "priority-withdrawal-batch", TransactionBcsTypeName: "transaction",
			TransactionBcsBytes: []byte("priority"),
			TotalPriorityFee:    candidates[0].PriorityFee + candidates[1].PriorityFee,
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(batch.TotalPriorityFee).To(Equal(int64(4_500_000)))
		processed, err := qtx.ProcessWithdrawals(ctx, db.ProcessWithdrawalsParams{
			ProcessingWithdrawalID: pgtype.Int8{Int64: batch.ProcessingWithdrawalID, Valid: true},
			WithdrawalIds:          []int64{candidates[0].WithdrawalID, candidates[1].WithdrawalID},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(processed).To(HaveLen(2))
		for _, withdrawal := range processed {
			Expect(withdrawal.ProcessingWithdrawalID).To(Equal(pgtype.Int8{Int64: batch.ProcessingWithdrawalID, Valid: true}))
		}
		Expect(tx.Commit(ctx)).To(Succeed())

		// Cleanup must leave the new processing batch and the waiting seller intact.
		cutoff := pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true}
		cleaned, err := s.CleanOldWithdrawals(ctx, cutoff)
		Expect(err).NotTo(HaveOccurred())
		Expect(cleaned).To(HaveLen(1))
		Expect(cleaned[0].ProcessingWithdrawalID).To(Equal(previous.ProcessingWithdrawalID))
		processing, err := s.ListProcessingWithdrawals(ctx, db.ListProcessingWithdrawalsParams{Limit: 10})
		Expect(err).NotTo(HaveOccurred())
		Expect(processing).To(HaveLen(1))
		Expect(processing[0].ProcessingWithdrawalID).To(Equal(batch.ProcessingWithdrawalID))

		completed, err := s.SetWithdrawalSuccess(ctx, batch.TransactionDigest)
		Expect(err).NotTo(HaveOccurred())
		Expect(completed.WithdrawalStatus).To(Equal("succeeded"))
		cleaned, err = s.CleanOldWithdrawals(ctx, cutoff)
		Expect(err).NotTo(HaveOccurred())
		Expect(cleaned).To(HaveLen(1))
		Expect(cleaned[0].ProcessingWithdrawalID).To(Equal(batch.ProcessingWithdrawalID))
		for index, withdrawal := range withdrawals {
			remaining, err := s.ListWithdrawals(ctx, db.ListWithdrawalsParams{AccountID: withdrawal.AccountID, Limit: 10})
			Expect(err).NotTo(HaveOccurred())
			if index == 2 {
				Expect(remaining).To(HaveLen(1))
				Expect(remaining[0].WithdrawalID).To(Equal(withdrawal.WithdrawalID))
				Expect(remaining[0].ProcessingWithdrawalID.Valid).To(BeFalse())
			} else {
				Expect(remaining).To(BeEmpty())
			}
		}
	})
})
