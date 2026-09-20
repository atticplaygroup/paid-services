package authzhttp

import (
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	ListenAddr           string `mapstructure:"LISTEN_ADDR"`
	RedisAddress         string `mapstructure:"REDIS_ADDR"`
	BalanceBackend       string `mapstructure:"BALANCE_BACKEND"`
	ExchangeDatabaseURL  string `mapstructure:"EXCHANGE_DATABASE_URL"`
	AllowZeroBalanceHTUs HTUs   `mapstructure:"ALLOW_ZERO_BALANCE_HTUS"`
	DPoPMaxAgeSeconds    int    `mapstructure:"AUTHZ_DPOP_MAX_AGE"`
}

type HTUs []string

func (h *HTUs) UnmarshalText(value string) error {
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			*h = append(*h, item)
		}
	}
	return nil
}

func (c Config) MaxAge() time.Duration {
	return time.Duration(c.DPoPMaxAgeSeconds) * time.Second
}

func LoadConfig(name, path string) (config Config) {
	viper.SetConfigFile(filepath.Join(path, name))
	viper.SetConfigType("env")

	viper.SetDefault("LISTEN_ADDR", ":9192")
	viper.SetDefault("BALANCE_BACKEND", "redis")
	viper.SetDefault("AUTHZ_DPOP_MAX_AGE", int(DefaultDPoPMaxAge/time.Second))
	for _, key := range []string{
		"LISTEN_ADDR", "REDIS_ADDR", "BALANCE_BACKEND",
		"EXCHANGE_DATABASE_URL", "ALLOW_ZERO_BALANCE_HTUS",
		"AUTHZ_DPOP_MAX_AGE",
	} {
		_ = viper.BindEnv(key)
	}

	if err := viper.ReadInConfig(); err != nil {
		log.Printf("config: %v (proceeding with env vars only)", err)
	}
	viper.AutomaticEnv()
	if err := viper.Unmarshal(&config); err != nil {
		log.Fatalf("config: %v", err)
	}
	return
}
