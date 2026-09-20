PORT=3000
KVSTORE_ADDRESS={{ .Values.env.kvstoreAddress }}
ALS_ADDRESS=https://{{ .Values.env.alsAddress }}
DEDUCTION_AMOUNT={{ .Values.env.deductionAmount }}
READ_ONLY_MODE={{ .Values.env.readOnlyMode }}
