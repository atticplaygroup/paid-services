{{- define "outproxy-with-faucet.fullname" -}}
{{- .Values.fullnameOverride | default .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "outproxy-with-faucet.cashierConfig" -}}
{{- $config := dict "accountSalt" (required "cashier.accountSalt is required" .Values.cashier.accountSalt) "defaultChainDepositAmount" .Values.cashier.defaultChainDepositAmount "defaultProviderDepositAmount" .Values.cashier.defaultProviderDepositAmount "accounts" (list (dict "principal" (required "cashier.principal must be derived from dpopMasterSecret and cashierAccountSalt" .Values.cashier.principal) "masterSecretMnemonic" (required "cashier.masterSecretMnemonic is required" .Values.cashier.masterSecretMnemonic) "payments" (list (dict "paymentCoin" "PAYMENT_COIN_SUI" "paymentEnvironment" .Values.cashier.paymentEnvironment "autoFaucet" .Values.cashier.autoFaucet "mnemonic" (required "cashier.walletMnemonic is required" .Values.cashier.walletMnemonic))))) "accountOriginOverrides" .Values.cashier.accountOriginOverrides "manifestOriginOverrides" .Values.cashier.manifestOriginOverrides }}
{{- $config | toJson -}}
{{- end -}}
