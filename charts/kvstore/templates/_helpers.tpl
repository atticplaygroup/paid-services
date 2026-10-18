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

{{- define "kvstore.s3Endpoint" -}}
{{- if .Values.s3.endpoint -}}
{{- .Values.s3.endpoint -}}
{{- else if .Values.s3.enabled -}}
{{- printf "%s-s3:9000" (include "kvstore.fullname" .) -}}
{{- else -}}
{{- fail "kvstore.s3.endpoint must be non-empty when embedded S3 is disabled" -}}
{{- end -}}
{{- end -}}

{{- define "kvstore.retentionDays" -}}
{{- $min := int .Values.s3.retentionRules.minDays -}}
{{- $max := int .Values.s3.retentionRules.maxDays -}}
{{- $step := int .Values.s3.retentionRules.stepDays -}}
{{- if or (lt $min 1) (lt $max $min) (lt $step 1) -}}
{{- fail "s3.retentionRules requires positive minDays and stepDays, and maxDays >= minDays" -}}
{{- end -}}
{{- $days := untilStep $min (int (add $max 1)) $step -}}
{{- if gt (len $days) 1000 -}}{{- fail "s3.retentionRules exceeds the S3 limit of 1000 rules" -}}{{- end -}}
{{- toJson $days -}}
{{- end -}}

{{- define "kvstore.s3Secret" -}}
{{- .Values.s3.existingSecret | default (printf "%s-s3" (include "kvstore.fullname" .)) -}}
{{- end -}}
