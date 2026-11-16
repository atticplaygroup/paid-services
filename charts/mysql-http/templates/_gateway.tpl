{{- define "mysql-http.workload" -}}
{{- $root := .root -}}
{{- $config := $root.Values.mysqlHttp -}}
{{- if $config.enabled -}}
{{- if not $root.Values.meter.enabled -}}
{{- fail "mysqlHttp requires meter.enabled=true for PAID authentication and metering" -}}
{{- end -}}
{{- $adminDSN := required "mysqlHttp.adminDsn is required" (.adminDsn | default $config.adminDsn) -}}
{{- $name := printf "%s-mysql-http" $root.Release.Name -}}
{{- $secret := lookup "v1" "Secret" $root.Release.Namespace $name -}}
{{- $password := randAlphaNum 40 -}}
{{- if and $secret $secret.data -}}
{{- $password = index $secret.data "password" | b64dec -}}
{{- end -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $name }}
  namespace: {{ $root.Release.Namespace }}
type: Opaque
stringData:
  password: {{ $password | quote }}
  admin-dsn: {{ $adminDSN | quote }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ $root.Release.Namespace }}
spec:
  replicas: 1
  selector:
    matchLabels: { app: {{ $name }} }
  template:
    metadata:
      labels: { app: {{ $name }} }
      annotations:
        mysql-config: {{ toJson (dict "access" $config.access "adminDsn" $adminDSN) | sha256sum | quote }}
    spec:
      enableServiceLinks: false
      initContainers:
        - name: provision-reader
          image: "{{ $config.image.repository }}:{{ $config.image.tag | default $root.Chart.AppVersion }}"
          imagePullPolicy: {{ $config.image.pullPolicy }}
          command: ["/mysql-http", "--provision"]
          env:
            - name: MYSQL_ADMIN_DSN
              valueFrom:
                secretKeyRef: { name: {{ $name }}, key: admin-dsn }
            - name: MYSQL_READER_USER
              value: {{ printf "paid_%s" (printf "%s/%s" $root.Release.Namespace $root.Release.Name | sha256sum | trunc 20) | quote }}
            - name: MYSQL_READER_PASSWORD
              valueFrom:
                secretKeyRef: { name: {{ $name }}, key: password }
            - name: MYSQL_ACCESS
              value: {{ toJson $config.access | quote }}
          volumeMounts:
            - { name: runtime, mountPath: /runtime }
      containers:
        - name: mysql-http
          image: "{{ $config.image.repository }}:{{ $config.image.tag | default $root.Chart.AppVersion }}"
          imagePullPolicy: {{ $config.image.pullPolicy }}
          command: ["/mysql-http"]
          env:
            - { name: QUERY_TIMEOUT, value: {{ $config.queryTimeout | quote }} }
            - { name: MAX_RESULT_BYTES, value: {{ $config.maxResultBytes | int64 | toString | quote }} }
          ports:
            - { name: http, containerPort: 3000 }
          readinessProbe:
            httpGet: { path: /healthz, port: http }
          volumeMounts:
            - { name: runtime, mountPath: /runtime, readOnly: true }
      volumes:
        - name: runtime
          emptyDir:
            medium: Memory
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  namespace: {{ $root.Release.Namespace }}
spec:
  selector: { app: {{ $name }} }
  ports:
    - { name: http, port: 3000, targetPort: http }
{{- end -}}
{{- end -}}
