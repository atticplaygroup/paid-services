package exchange

import (
	"context"
	"encoding/base64"
	"fmt"
	"math/big"
	"os"
	"strings"

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
	Signer        signer.Signer
	EpochGetter   IEpochGetter
}

func NewSuiPaymentClient(network string, walletSigner *signer.Signer) (*SuiPaymentClient, error) {
	var clientUrl string
	switch network {
	case "localnet":
		clientUrl = envOr("SUI_GRPC_URL", "sui-localnet:9000")
	case "mainnet":
		clientUrl = "fullnode.mainnet.sui.io:443"
	case "testnet":
		clientUrl = "fullnode.testnet.sui.io:443"
	case "devnet":
		clientUrl = "fullnode.devnet.sui.io:443"
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
	ledger, err := c.SuiGrpcClient.LedgerService(ctx)
	if err != nil {
		return nil, fmt.Errorf("get ledger service: %w", err)
	}
	// Verify the executed transaction directly on the fullnode.
	response, err := ledger.GetTransaction(ctx, &v2.GetTransactionRequest{
		Digest: &digest,
		ReadMask: &fieldmaskpb.FieldMask{Paths: []string{
			"digest", "transaction.sender", "effects.status", "effects.epoch", "balance_changes",
		}},
	})
	if err != nil {
		return nil, fmt.Errorf("get deposit transaction: %w", err)
	}
	return checkTransaction(response.GetTransaction(), digest, c.Signer.Address, currentEpoch.GetEpoch(), maxGapEpochs)
}

func checkTransaction(tx *v2.ExecutedTransaction, digest, recipient string, currentEpoch uint64, maxGapEpochs int) (*DepositTransferInfo, error) {
	if tx == nil || tx.GetDigest() != digest || tx.GetTransaction().GetSender() == "" {
		return nil, fmt.Errorf("no transaction found for digest")
	}
	if !tx.GetEffects().GetStatus().GetSuccess() || tx.GetEffects().Epoch == nil {
		return nil, fmt.Errorf("deposit transaction did not succeed")
	}
	epoch := tx.GetEffects().GetEpoch()
	if maxGapEpochs < 0 || epoch > currentEpoch || currentEpoch-epoch > uint64(maxGapEpochs) {
		return nil, fmt.Errorf("deposit too late")
	}
	amount := new(big.Int)
	for _, change := range tx.GetBalanceChanges() {
		coin := strings.Split(change.GetCoinType(), "::")
		if change.GetAddress() != recipient || len(coin) != 3 ||
			strings.TrimLeft(strings.TrimPrefix(coin[0], "0x"), "0") != "2" || coin[1] != "sui" || coin[2] != "SUI" {
			continue
		}
		value, ok := new(big.Int).SetString(change.GetAmount(), 10)
		if !ok {
			return nil, fmt.Errorf("parse deposit amount: %s", change.GetAmount())
		}
		amount.Add(amount, value)
	}
	if amount.Sign() <= 0 || !amount.IsInt64() {
		return nil, fmt.Errorf("invalid SUI deposit amount")
	}
	return &DepositTransferInfo{
		TransferInfo: &TransferInfo{Amount: amount.Int64(), Address: tx.GetTransaction().GetSender()},
		Epoch:        int64(epoch),
	}, nil
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
