package account

import (
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"

	"github.com/spf13/viper"
)

type Config struct {
	RedisHost string `mapstructure:"REDIS_HOST"`
	RedisPort uint16 `mapstructure:"REDIS_PORT"`
	GrpcPort  uint16 `mapstructure:"GRPC_PORT"`

	ListenAddress string `mapstructure:"LISTEN_ADDRESS"`

	TrustedIssuersJSON string          `mapstructure:"TRUSTED_ISSUERS"`
	TrustedIssuers     []TrustedIssuer `mapstructure:"-"`
	ValidAudience      string          `mapstructure:"VALID_AUDIENCE"`

	FaucetMode bool `mapstructure:"FAUCET_MODE"`

	UserIdHeaderName    string `mapstructure:"USER_ID_HEADER_NAME"`
	RequestIdHeaderName string `mapstructure:"REQUEST_ID_HEADER_NAME"`

	ValidCoinType        int64 `mapstructure:"VALID_COIN_TYPE"`
	ValidCoinEnvironment int64 `mapstructure:"VALID_COIN_ENVIRONMENT"`

	BalanceBackend      string `mapstructure:"BALANCE_BACKEND"`
	ExchangeDatabaseURL string `mapstructure:"EXCHANGE_DATABASE_URL"`
}

func LoadConfig(name string, path string) (config Config) {
	viper.SetConfigFile(filepath.Join(path, name))
	viper.SetConfigType("env")

	viper.SetDefault("GRPC_PORT", 8080)
	viper.SetDefault("LISTEN_ADDRESS", "0.0.0.0")
	viper.SetDefault("REDIS_PORT", 6379)
	viper.SetDefault("FAUCET_MODE", false)
	viper.SetDefault("VALID_COIN_TYPE", 1)
	viper.SetDefault("VALID_COIN_ENVIRONMENT", 4)
	viper.SetDefault("BALANCE_BACKEND", "redis")
	viper.SetDefault("USER_ID_HEADER_NAME", "x-user-id")
	viper.SetDefault("REQUEST_ID_HEADER_NAME", "x-request-id")
	for _, k := range []string{
		"REDIS_HOST", "REDIS_PORT", "GRPC_PORT", "FAUCET_MODE",
		"TRUSTED_ISSUERS", "VALID_AUDIENCE",
		"VALID_COIN_TYPE", "VALID_COIN_ENVIRONMENT",
		"BALANCE_BACKEND", "EXCHANGE_DATABASE_URL",
		"USER_ID_HEADER_NAME", "REQUEST_ID_HEADER_NAME",
	} {
		_ = viper.BindEnv(k)
	}

	if err := viper.ReadInConfig(); err != nil {
		log.Printf("config: %v (proceeding with env vars only)", err)
	}
	viper.AutomaticEnv()
	if err := viper.Unmarshal(&config); err != nil {
		log.Fatalf("config: %v", err)
	}
	if config.TrustedIssuersJSON != "" {
		if err := json.Unmarshal([]byte(config.TrustedIssuersJSON), &config.TrustedIssuers); err != nil {
			log.Fatalf("TRUSTED_ISSUERS: %v", err)
		}
	}
	return
}

type TrustedIssuer struct {
	Issuer  string `json:"issuer"`
	JWKSURL string `json:"jwksUrl"`
}

func (t TrustedIssuer) Validate() error {
	if t.Issuer == "" || t.JWKSURL == "" {
		return fmt.Errorf("issuer and jwksUrl are required")
	}
	return nil
}
