PORT=3000
KVSTORE_ADDRESS={{ .Values.env.kvstoreAddress }}
DEDUCTION_ADDRESS=https://{{ .Values.env.deductionAddress }}
DEDUCTION_AMOUNT={{ .Values.env.deductionAmount }}
READ_ONLY_MODE={{ .Values.env.readOnlyMode }}
