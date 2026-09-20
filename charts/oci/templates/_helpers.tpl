{{- define "oci.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "oci.requiredAccountDomains" -}}
{{- $domains := .Values.env.accountDomains -}}
{{- if not $domains -}}
{{- fail "oci.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- range $domains -}}
{{- if not (and (kindIs "string" .) (ne . "")) -}}
{{- fail "oci.env.accountDomains hosts must be non-empty strings" -}}
{{- end -}}
{{- end -}}
{{- toJson $domains -}}
{{- end -}}
