{{- define "kvstore.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{ .Values.fullnameOverride }}
{{- else -}}
{{ .Release.Name }}
{{- end -}}
{{- end -}}
{{- define "kvstore.requiredAccountDomains" -}}
{{- $domains := .Values.env.accountDomains -}}
{{- if not $domains -}}
{{- fail "kvstore.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- range $domains -}}
{{- if not (and (kindIs "string" .) (ne . "")) -}}
{{- fail "kvstore.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- end -}}
{{- toJson $domains -}}
{{- end -}}
