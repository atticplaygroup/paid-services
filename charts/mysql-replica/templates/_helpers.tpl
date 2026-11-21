{{- define "mysql-replica.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "mysql-replica.requiredAccountDomains" -}}
{{- $domains := .Values.env.accountDomains -}}
{{- if not $domains -}}
{{- fail "mysql-replica.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- range $domains -}}
{{- if not (and (kindIs "string" .) (ne . "")) -}}
{{- fail "mysql-replica.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- end -}}
{{- toJson $domains -}}
{{- end -}}
