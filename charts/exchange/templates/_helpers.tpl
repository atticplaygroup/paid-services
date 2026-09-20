{{- define "exchange.name" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "exchange.fullname" -}}
{{- include "exchange.name" . -}}
{{- end }}

{{- define "exchange.requiredAccountDomains" -}}
{{- $domains := .Values.env.accountDomains -}}
{{- if not $domains -}}
{{- fail "exchange.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- range $domains -}}
{{- if not (and (kindIs "string" .) (ne . "")) -}}
{{- fail "exchange.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- end -}}
{{- toJson $domains -}}
{{- end -}}
