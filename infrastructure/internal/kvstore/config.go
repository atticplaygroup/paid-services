package kvstore

import (
	"log"
	"path/filepath"

	"github.com/spf13/viper"
)

type Config struct {
	RedisHost            string `mapstructure:"REDIS_HOST"`
	RedisPort            uint16 `mapstructure:"REDIS_PORT"`
	GrpcPort             uint16 `mapstructure:"GRPC_PORT"`
	BillingServerAddress string `mapstructure:"BILLING_SERVER_ADDRESS"`

	ListenAddress string `mapstructure:"LISTEN_ADDRESS"`

	UserIdHeaderName            string `mapstructure:"USER_ID_HEADER_NAME"`
	RequestIdHeaderName         string `mapstructure:"REQUEST_ID_HEADER_NAME"`
	ExternalRequestIdHeaderName string `mapstructure:"EXTERNAL_REQUEST_ID_HEADER_NAME"`

	// S3 / MinIO (STORAGE_BACKEND_BLOB_STORAGE)
	MinioEndpoint  string `mapstructure:"MINIO_ENDPOINT"`
	MinioBucket    string `mapstructure:"MINIO_BUCKET"`
	MinioAccessKey string `mapstructure:"MINIO_ACCESS_KEY"`
	MinioSecretKey string `mapstructure:"MINIO_SECRET_KEY"`
}

func LoadConfig(name string, path string) (config Config) {
	viper.SetConfigFile(filepath.Join(path, name))
	viper.SetConfigType("env")
	viper.AutomaticEnv()
	viper.SetDefault("REDIS_PORT", 6379)
	viper.SetDefault("GRPC_PORT", 8080)
	viper.SetDefault("LISTEN_ADDRESS", "0.0.0.0")
	viper.SetDefault("USER_ID_HEADER_NAME", "x-user-id")
	viper.SetDefault("REQUEST_ID_HEADER_NAME", "x-request-id")
	viper.SetDefault("EXTERNAL_REQUEST_ID_HEADER_NAME", "x-external-request-id")
	for _, k := range []string{
		"MINIO_ENDPOINT", "MINIO_BUCKET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
		"REDIS_HOST", "REDIS_PORT", "GRPC_PORT", "BILLING_SERVER_ADDRESS",
	} {
		_ = viper.BindEnv(k)
	}

	if err := viper.ReadInConfig(); err != nil {
		log.Printf("config: %v (proceeding with env vars only)", err)
	}
	if err := viper.Unmarshal(&config); err != nil {
		log.Fatalf("config: %v", err)
	}
	return
}
