package als

import (
	"log"
	"path/filepath"
	"time"

	"github.com/spf13/viper"
)

const DefaultMeterFeedbackTTL = 10 * time.Second

type Config struct {
	ListenAddr              string `mapstructure:"LISTEN_ADDR"`
	ConnectListenAddr       string `mapstructure:"CONNECT_LISTEN_ADDR"`
	RedisAddress            string `mapstructure:"REDIS_ADDR"`
	BalanceBackend          string `mapstructure:"BALANCE_BACKEND"`
	ExchangeDatabaseURL     string `mapstructure:"EXCHANGE_DATABASE_URL"`
	MeterFeedbackEnabled    bool   `mapstructure:"METER_FEEDBACK_ENABLED"`
	MeterFeedbackTTLSeconds int    `mapstructure:"METER_FEEDBACK_TTL_SECONDS"`
	OutproxyAddress         string `mapstructure:"OUTPROXY_ADDRESS"`
}

func (c Config) MeterFeedbackTTL() time.Duration {
	return time.Duration(c.MeterFeedbackTTLSeconds) * time.Second
}

func LoadConfig(name, path string) (config Config) {
	viper.SetConfigFile(filepath.Join(path, name))
	viper.SetConfigType("env")

	viper.SetDefault("LISTEN_ADDR", ":9192")
	viper.SetDefault("CONNECT_LISTEN_ADDR", ":9193")
	viper.SetDefault("BALANCE_BACKEND", "redis")
	viper.SetDefault("METER_FEEDBACK_TTL_SECONDS", int(DefaultMeterFeedbackTTL/time.Second))
	for _, key := range []string{
		"LISTEN_ADDR", "CONNECT_LISTEN_ADDR", "REDIS_ADDR",
		"BALANCE_BACKEND", "EXCHANGE_DATABASE_URL",
		"METER_FEEDBACK_ENABLED", "METER_FEEDBACK_TTL_SECONDS",
		"OUTPROXY_ADDRESS",
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
