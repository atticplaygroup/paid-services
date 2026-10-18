package exchange

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func TestLoadConfigSecretEnvironment(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)
	seed := "0x" + strings.Repeat("01", 32)
	mnemonic := "test test test test test test test test test test test junk"
	t.Setenv("TOKEN_SIGNING_SEED", seed)
	t.Setenv("WALLET_MNEMONIC", mnemonic)
	path := filepath.Join(t.TempDir(), "exchange.env")
	if err := os.WriteFile(path, []byte("TOKEN_ISSUER=https://issuer.example.com\nSUI_NETWORK=devnet\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config := LoadConfig(path)
	if config.TokenSigningSeed != seed || config.WalletMnemonic != mnemonic {
		t.Fatal("Secret environment variables were not loaded without ConfigMap entries")
	}
}
