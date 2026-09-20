{{- define "cashier.name" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "cashier.fullname" -}}
{{- include "cashier.name" . -}}
{{- end }}
