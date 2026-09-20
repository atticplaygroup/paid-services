package exchange

import (
	"crypto/ed25519"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/block-vision/sui-go-sdk/signer"
	"github.com/spf13/viper"
)

type Config struct {
	AccountTtlPrice        float64 `mapstructure:"ACCOUNT_TTL_PRICE"`
	MaxExpirationExtension int64   `mapstructure:"MAX_EXPIRATION_EXTENSION"`

	WithdrawRecipientCount   int32  `mapstructure:"WITHDRAW_RECIPIENT_COUNT"`
	WithdrawCheckStatusCount int32  `mapstructure:"WITHDRAW_CHECK_STATUS_COUNT"`
	WalletMnemonic           string `mapstructure:"WALLET_MNEMONIC"`
	WalletSigner             signer.Signer
	SuiNetwork               string `mapstructure:"SUI_NETWORK"`
	TokenSigningSeed         string `mapstructure:"TOKEN_SIGNING_SEED"`
	TokenSigningPrivateKey   ed25519.PrivateKey
	TokenSigningKeyId        string

	TokenSigningPublic ed25519.PublicKey

	DatabaseURL   string `mapstructure:"DATABASE_URL"`
	ListenAddress string `mapstructure:"LISTEN_ADDRESS"`

	MessageAuthTimeout time.Duration `mapstructure:"MESSAGE_AUTH_TIMEOUT"`
	MaxDepositEpochGap int64         `mapstructure:"MAX_DEPOSIT_EPOCH_GAP"`
	SessionTimeout     time.Duration `mapstructure:"SESSION_TIMEOUT"`

	TokenTtl time.Duration `mapstructure:"TOKEN_TTL"`

	GrpcPort uint16 `mapstructure:"GRPC_PORT"`

	UserIdHeaderName    string `mapstructure:"USER_ID_HEADER_NAME"`
	RequestIdHeaderName string `mapstructure:"REQUEST_ID_HEADER_NAME"`

	// Stamped onto BuyToken JWTs; must match kvstore VALID_COIN_*.
	TokenCoinType        int64 `mapstructure:"TOKEN_COIN_TYPE"`
	TokenCoinEnvironment int64 `mapstructure:"TOKEN_COIN_ENVIRONMENT"`
}

func LoadConfig(path string) (config Config) {
	if filepath.Ext(path) != "" || strings.Contains(filepath.Base(path), ".") {
		viper.SetConfigFile(path)
	} else {
		viper.AddConfigPath(filepath.Dir(path))
		viper.SetConfigName(filepath.Base(path))
		viper.SetConfigType("env")
	}
	viper.SetConfigType("env")
	viper.AutomaticEnv()
	viper.SetDefault("GRPC_PORT", 8080)
	viper.SetDefault("LISTEN_ADDRESS", "0.0.0.0")
	viper.SetDefault("USER_ID_HEADER_NAME", "x-user-id")
	viper.SetDefault("REQUEST_ID_HEADER_NAME", "x-request-id")
	viper.SetDefault("TOKEN_COIN_TYPE", 1)        // COIN_TYPE_SUI
	viper.SetDefault("TOKEN_COIN_ENVIRONMENT", 4) // COIN_ENVIRONMENT_LOCALNET

	if err := viper.ReadInConfig(); err != nil {
		log.Printf("config: %v (proceeding with env vars only)", err)
	}
	if err := viper.Unmarshal(&config); err != nil {
		log.Fatalf("config: %v", err)
	}

	seed, err := utils.HexToBytes32(config.TokenSigningSeed)
	if err != nil {
		log.Fatalf("parse TokenSigningSeed %s: %v", config.TokenSigningSeed, err)
	}
	if len(seed) != ed25519.SeedSize {
		log.Fatalf("expect seed to have len %d but got %d: %v", ed25519.SeedSize, len(seed), seed)
	}
	config.TokenSigningPrivateKey = ed25519.NewKeyFromSeed(seed)
	config.TokenSigningPublic = config.TokenSigningPrivateKey.Public().(ed25519.PublicKey)
	tokenSigningKeyCid, err := utils.FormatPrincipal(config.TokenSigningPrivateKey.Public())
	if err != nil {
		log.Fatalf("token signing key id: %v", err)
	}
	config.TokenSigningKeyId = tokenSigningKeyCid.String()
	fmt.Printf("issuer: %s\n", config.TokenSigningKeyId)

	signer, err := signer.NewSignertWithMnemonic(config.WalletMnemonic)
	if err != nil {
		log.Fatalf("load mnemonic: %v", err)
	}
	config.WalletSigner = *signer

	return
}
