package exchange

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/shurcooL/graphql"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	"github.com/block-vision/sui-go-sdk/common/grpcconn"
	"github.com/block-vision/sui-go-sdk/constant"
	"github.com/block-vision/sui-go-sdk/models"
	"github.com/block-vision/sui-go-sdk/mystenbcs"
	v2 "github.com/block-vision/sui-go-sdk/pb/sui/rpc/v2"
	"github.com/block-vision/sui-go-sdk/signer"
	suiV2 "github.com/block-vision/sui-go-sdk/sui/v2"
	"github.com/block-vision/sui-go-sdk/transaction"
)

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

type IEpochGetter interface {
	GetCurrentEpoch(context.Context) (*v2.Epoch, error)
}

type PaymentClient interface {
	CheckTransactionStatus(ctx context.Context, digest string) (TransactionStatus, error)
	PrepareWithdrawTransaction(ctx context.Context, info []TransferInfo, gasBudget uint64) (*WithdrawInformation, error)
	Withdraw(ctx context.Context, batchTx *WithdrawInformation) (string, error)
	CheckDeposit(ctx context.Context, digest string, maxGapEpochs int) (*DepositTransferInfo, error)
}

type EpochGetter struct {
	suiClient     suiV2.Client
	SuiGrpcClient *grpcconn.SuiGrpcClient
}

type SuiPaymentClient struct {
	SuiClient     suiV2.Client
	SuiGrpcClient *grpcconn.SuiGrpcClient
	GqlClient     *graphql.Client
	Signer        signer.Signer
	EpochGetter   IEpochGetter
}

func NewSuiPaymentClient(network string, walletSigner *signer.Signer) (*SuiPaymentClient, error) {
	var clientUrl, graphqlClientUrl string
	switch network {
	case "localnet":
		clientUrl = envOr("SUI_GRPC_URL", "sui-localnet:9000")
		graphqlClientUrl = envOr("SUI_GRAPHQL_URL", "http://sui-localnet:9125/graphql")
	case "mainnet":
		clientUrl = "fullnode.mainnet.sui.io:443"
		graphqlClientUrl = "https://graphql.mainnet.sui.io/graphql"
	case "testnet":
		clientUrl = "fullnode.testnet.sui.io:443"
		graphqlClientUrl = "https://graphql.testnet.sui.io/graphql"
	case "devnet":
		clientUrl = "fullnode.devnet.sui.io:443"
		graphqlClientUrl = "https://graphql.devnet.sui.io/graphql"
	default:
		return nil, fmt.Errorf("unknown network %s", network)
	}
	if v := strings.TrimSpace(os.Getenv("PAYMENT_SERVICE_URL")); v != "" && network == "localnet" {
		clientUrl = strings.TrimPrefix(strings.TrimPrefix(v, "https://"), "http://")
	}

	gc := grpcconn.NewSuiGrpcClient(clientUrl, grpcconn.WithDialOptions(
		grpc.WithTransportCredentials(credentials.NewTLS(nil)),
	))
	suiClient, err := suiV2.NewClient(suiV2.ClientOptions{
		GrpcClient: gc,
	})
	if err != nil {
		return nil, err
	}
	ret := SuiPaymentClient{
		SuiClient:     suiClient,
		SuiGrpcClient: gc,
		GqlClient:     graphql.NewClient(graphqlClientUrl, nil),
		Signer:        *walletSigner,
	}
	ret.EpochGetter = &EpochGetter{suiClient: suiClient, SuiGrpcClient: gc}
	return &ret, nil
}

func (c *SuiPaymentClient) GetCurrentEpoch(ctx context.Context) (*v2.Epoch, error) {
	return c.EpochGetter.GetCurrentEpoch(ctx)
}

func (c *SuiPaymentClient) SetEpochGetter(eg IEpochGetter) {
	c.EpochGetter = eg
}

func (c *EpochGetter) GetCurrentEpoch(ctx context.Context) (*v2.Epoch, error) {
	ledgerService, err := c.SuiGrpcClient.LedgerService(ctx)
	if err != nil {
		return nil, err
	}
	systemSummary, err := ledgerService.GetEpoch(ctx, &v2.GetEpochRequest{})
	if err != nil {
		return nil, err
	}
	return systemSummary.GetEpoch(), nil
}

type TransactionStatus int

const (
	UNKNOWN TransactionStatus = 0
	SUCCESS TransactionStatus = 1
	FAIL    TransactionStatus = 2
	PENDING TransactionStatus = 3
)

func (c *SuiPaymentClient) CheckTransactionStatus(
	ctx context.Context,
	digest string,
) (TransactionStatus, error) {
	ledgerService, err := c.SuiGrpcClient.LedgerService(ctx)
	if err != nil {
		return UNKNOWN, err
	}
	_, err = ledgerService.GetTransaction(ctx, &v2.GetTransactionRequest{
		Digest: &digest,
	})
	if err != nil {
		if strings.Contains(err.Error(), "Could not find the referenced transaction") {
			return PENDING, nil
		} else {
			return UNKNOWN, fmt.Errorf("get current epoch: %w", err)
		}
	}
	return SUCCESS, nil
}

type TransferInfo struct {
	Address string
	Amount  int64
}

type WithdrawInformation struct {
	Transaction *v2.Transaction
	SigBytes    []byte
}

func (c *SuiPaymentClient) PrepareWithdrawTransaction(
	ctx context.Context, info []TransferInfo, gasBudget uint64,
) (*WithdrawInformation, error) {
	batchTx, err := c.buildWithdrawalTransaction(ctx, info, gasBudget)
	if err != nil {
		return nil, fmt.Errorf("build withdrawal transaction: %w", err)
	}
	if err := c.simulatePay(ctx, batchTx.Transaction); err != nil {
		return nil, fmt.Errorf("simulate pay: %w", err)
	}

	return batchTx, nil
}

func (c *SuiPaymentClient) buildWithdrawalTransaction(
	ctx context.Context, transferInfo []TransferInfo, gasBudget uint64,
) (*WithdrawInformation, error) {
	currentEpoch, err := c.EpochGetter.GetCurrentEpoch(ctx)
	if err != nil {
		return nil, fmt.Errorf("get current epoch: %w", err)
	}
	gasPrice := currentEpoch.GetReferenceGasPrice()
	if int64(gasPrice) < 0 {
		return nil, fmt.Errorf("not positive gas price: %d", gasPrice)
	}

	tx := transaction.NewTransaction()
	tx.SetSigner(&c.Signer)
	tx.SetGasPrice(gasPrice)
	tx.SetGasBudget(gasBudget)

	gasCoin, err := fetchFirstSuiCoin(ctx, c.SuiGrpcClient, c.Signer.Address)
	if err != nil {
		return nil, fmt.Errorf("get gas coin: %w", err)
	}
	tx.SetGasPayment([]transaction.SuiObjectRef{*gasCoin})

	for _, t := range transferInfo {
		splitResult := tx.SplitCoins(tx.Gas(), []transaction.Argument{tx.Pure(t.Amount)})
		tx.TransferObjects([]transaction.Argument{splitResult}, tx.Pure(t.Address))
	}

	bcsBytes, err := tx.BuildBCSBytes(ctx)
	if err != nil {
		return nil, fmt.Errorf("build bcs bytes: %w", err)
	}

	b64TxBytes := mystenbcs.ToBase64(bcsBytes)
	signed, err := c.Signer.SignMessage(b64TxBytes, constant.TransactionDataIntentScope)
	if err != nil {
		return nil, fmt.Errorf("SignMessage: %w", err)
	}
	sigBytes, err := base64.StdEncoding.DecodeString(signed.Signature)
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	v2Transaction := &v2.Transaction{
		Bcs: &v2.Bcs{Value: bcsBytes},
	}
	return &WithdrawInformation{
		Transaction: v2Transaction,
		SigBytes:    sigBytes,
	}, nil
}

func (c *SuiPaymentClient) simulatePay(
	ctx context.Context,
	v2Transaction *v2.Transaction,
) error {
	transactionService, err := c.SuiGrpcClient.TransactionExecutionService(ctx)
	if err != nil {
		return fmt.Errorf("get transaction execution service: %w", err)
	}

	doGasSelection := true
	_, err = transactionService.SimulateTransaction(ctx, &v2.SimulateTransactionRequest{
		Transaction:    v2Transaction,
		DoGasSelection: &doGasSelection,
	})
	if err != nil {
		return fmt.Errorf("simulation: %w", err)
	}
	return nil
}

func (c *SuiPaymentClient) Withdraw(
	ctx context.Context, batchTx *WithdrawInformation,
) (string, error) {
	transactionService, err := c.SuiGrpcClient.TransactionExecutionService(ctx)
	if err != nil {
		return "", fmt.Errorf("get transaction execution service: %w", err)
	}

	v2ReadMask := &fieldmaskpb.FieldMask{
		Paths: []string{"digest", "effects.status", "effects.gas_used"},
	}
	resp, err := transactionService.ExecuteTransaction(ctx, &v2.ExecuteTransactionRequest{
		Transaction: batchTx.Transaction,
		Signatures: []*v2.UserSignature{
			{Bcs: &v2.Bcs{Value: batchTx.SigBytes}},
		},
		ReadMask: v2ReadMask,
	})
	if err != nil {
		return "", fmt.Errorf("ExecuteTransaction: %w", err)
	}

	fmt.Printf("resp: %v\n", resp)
	if resp.Transaction == nil {
		return "", fmt.Errorf("ExecuteTransaction: empty response")
	}
	return resp.GetTransaction().GetDigest(), nil
}

type DepositTransferInfo struct {
	*TransferInfo
	Epoch int64
}

func (c *SuiPaymentClient) CheckDeposit(ctx context.Context, digest string, maxGapEpochs int) (*DepositTransferInfo, error) {
	currentEpoch, err := c.EpochGetter.GetCurrentEpoch(ctx)
	if err != nil {
		return nil, fmt.Errorf("get current epoch: %w", err)
	}
	var q struct {
		Transaction struct {
			Sender struct {
				Address string
			}
			Effects struct {
				BalanceChanges struct {
					Nodes []struct {
						Owner struct {
							Address string
						}
						Amount   string
						CoinType struct {
							Repr string
						}
					}
				}
				Timestamp string
				Epoch     struct {
					EpochId int
				}
			}
		} `graphql:"transaction(digest: $digest)"`
	}

	variables := map[string]any{
		"digest": digest,
	}
	err = c.GqlClient.Query(ctx, &q, variables)
	if err != nil {
		return nil, fmt.Errorf("graphql query failed: %w", err)
	}
	if q.Transaction.Sender.Address == "" {
		return nil, fmt.Errorf("no transaction found for digest")
	}
	if q.Transaction.Effects.Epoch.EpochId+maxGapEpochs < int(currentEpoch.GetEpoch()) {
		return nil, fmt.Errorf("deposit too late")
	}
	for _, node := range q.Transaction.Effects.BalanceChanges.Nodes {
		if node.Amount != "" && node.Owner.Address == c.Signer.Address {
			amount, err := strconv.Atoi(node.Amount)
			if err != nil {
				return nil, fmt.Errorf("parse amount: %s", node.Amount)
			}
			// FIXME: currently only the first matching effect is considered. User will lose money if they deposit with multiple effects.
			return &DepositTransferInfo{
				TransferInfo: &TransferInfo{
					Amount:  int64(amount),
					Address: q.Transaction.Sender.Address,
				},
				Epoch: int64(q.Transaction.Effects.Epoch.EpochId),
			}, nil
		}
	}
	return nil, fmt.Errorf("no valid transaction found")
}

// fetchFirstSuiCoin returns the first SUI coin owned by the address, suitable
// as a gas payment object.
// TODO: What if first coin not enough
func fetchFirstSuiCoin(ctx context.Context, client *grpcconn.SuiGrpcClient, address string) (*transaction.SuiObjectRef, error) {
	stateService, err := client.StateService(ctx)
	if err != nil {
		return nil, fmt.Errorf("StateService: %w", err)
	}

	coinType := "0x2::coin::Coin<0x2::sui::SUI>"
	pageSize := uint32(1)
	resp, err := stateService.ListOwnedObjects(ctx, &v2.ListOwnedObjectsRequest{
		Owner:      &address,
		ObjectType: &coinType,
		PageSize:   &pageSize,
		ReadMask: &fieldmaskpb.FieldMask{
			Paths: []string{"object_id", "version", "digest"},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("ListOwnedObjects: %w", err)
	}
	if len(resp.Objects) == 0 {
		return nil, fmt.Errorf("no SUI coins found for address %s", address)
	}

	obj := resp.Objects[0]
	ref, err := transaction.NewSuiObjectRef(
		models.SuiAddress(obj.GetObjectId()),
		fmt.Sprintf("%d", obj.GetVersion()),
		models.ObjectDigest(obj.GetDigest()),
	)
	if err != nil {
		return nil, fmt.Errorf("NewSuiObjectRef: %w", err)
	}
	return ref, nil
}
