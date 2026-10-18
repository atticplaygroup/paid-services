package store_test

import (
	"context"

	_ "github.com/lib/pq" // PostgreSQL driver

	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/jackc/pgx/v5/pgtype"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Checking deposit into database", Label("db"), func() {
	BeforeEach(func() {
		RefreshDb(StoreTestDb, Migrations)
	})

	When("user deposits", func() {
		It("should deposit successfully", func() {
			ctx := context.Background()
			s := *StoreInstance
			account1, err := s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
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
			Expect(err).To(BeNil())
			Expect(account1.AccountID).To(Not(BeNil()))

			account, err := s.QueryBalance(ctx, "test_user_1")
			Expect(err).To(BeNil())
			Expect(account.AccountID).To(Equal(account1.AccountID))
			Expect(account.Balance).To(Equal(int64(1_000_000)))

			newAccount, err := s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhp1",
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: "test_user_1",
					Balance:   2_000_000,
					Ttl: pgtype.Interval{
						Microseconds: 0,
						Valid:        true,
					},
					Privilege: "user",
				},
			})
			Expect(err).To(BeNil())
			Expect(newAccount.AccountID).To(Equal(account1.AccountID))
			newAccount1, err := s.QueryBalance(ctx, "test_user_1")
			Expect(err).To(BeNil())
			Expect(newAccount1.Balance).To(Equal(int64(3_000_000)))
		})
	})

	When("user duplicates deposit with the same digest", func() {
		It("should reject the deposit", func() {
			ctx := context.Background()
			s := *StoreInstance
			params := &store.UpsertAccountTxParams{
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
			}
			accountId, err := s.UpsertAccountTx(ctx, params)
			Expect(err).To(BeNil())
			Expect(accountId).To(Not(BeNil()))

			newAccountId, err := s.UpsertAccountTx(ctx, params)
			Expect(err).To(MatchError(ContainSubstring("duplicate key value violates unique constraint")))
			Expect(newAccountId).To(BeNil())
		})
	})

	When("a buyer purchases tokens for a seller", func() {
		It("debits and credits balances by the purchase amount", func() {
			ctx := context.Background()
			s := *StoreInstance

			_, err := s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: "test-buyer-digest",
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: "bafk-test-buyer",
					Balance:   250,
					Ttl:       pgtype.Interval{Microseconds: 3600 * 24 * 1000, Valid: true},
					Privilege: "user",
				},
			})
			Expect(err).To(BeNil())
			_, err = s.UpsertAccountTx(ctx, &store.UpsertAccountTxParams{
				Digest: "test-seller-digest",
				UpsertAccountParams: db.UpsertAccountParams{
					Principal: "bafk-test-seller",
					Balance:   125,
					Ttl:       pgtype.Interval{Microseconds: 3600 * 24 * 1000, Valid: true},
					Privilege: "user",
				},
			})
			Expect(err).To(BeNil())

			err = s.BuyPointsTx(ctx, s.Queries, &store.BuyPointsTxParams{
				Req: &pb.BuyPointsRequest{
					Audience: "bafk-test-seller",
					Amount:   100,
				},
				BuyerPrincipal: "bafk-test-buyer",
			})
			Expect(err).To(BeNil())

			buyerAfter, err := s.QueryBalance(ctx, "bafk-test-buyer")
			Expect(err).To(BeNil())
			Expect(buyerAfter.Balance).To(Equal(int64(150)))
			sellerAfter, err := s.QueryBalance(ctx, "bafk-test-seller")
			Expect(err).To(BeNil())
			Expect(sellerAfter.Balance).To(Equal(int64(225)))
		})
	})
})
