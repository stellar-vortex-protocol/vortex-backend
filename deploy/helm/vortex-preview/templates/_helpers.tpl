{{/*
Common naming and labelling for the preview chart.

Everything is namespace-scoped: the release name *is* the namespace (pr-<n>),
so resources are named after the release rather than after a chart-wide
fullname — that keeps `kubectl -n pr-<n> get all` readable and makes the
cost-cap / TTL queries (which key off the namespace label) the single source
of identity.
*/}}

{{- define "vortex-preview.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "vortex-preview.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "vortex-preview.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Labels applied to every object. `app.kubernetes.io/managed-by` and the chart
label are what `helm uninstall` and `helm list` key on; the vortex/* labels
carry preview-specific identity used by the workflow's cap check and TTL sweep
(cluster-side queries never parse resource names).
*/}}
{{- define "vortex-preview.labels" -}}
helm.sh/chart: {{ include "vortex-preview.chart" . }}
app.kubernetes.io/name: {{ include "vortex-preview.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: vortex-preview
{{- if .Values.preview.prNumber }}
vortex.io/preview-pr: {{ .Values.preview.prNumber | quote }}
{{- end }}
{{- end -}}

{{- define "vortex-preview.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vortex-preview.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* In-cluster hostnames, derived from the release name (namespace-scoped). */}}
{{- define "vortex-preview.pgHost" -}}
{{ include "vortex-preview.fullname" . }}-postgres
{{- end -}}

{{- define "vortex-preview.redisHost" -}}
{{ include "vortex-preview.fullname" . }}-redis
{{- end -}}

{{/*
Redis-derived settings for the app. One place computes "is Redis on?" so the
backplane, queue driver and flag pub/sub can never disagree — a preview with
WS_BACKPLANE=redis but JOBS_DRIVER=memory would boot and then fail at runtime
in exactly the way that wastes a reviewer's afternoon.
*/}}
{{- define "vortex-preview.redisUrl" -}}
{{- if .Values.redis.enabled -}}
redis://{{ include "vortex-preview.redisHost" . }}:6379
{{- end -}}
{{- end -}}

{{- define "vortex-preview.backplane" -}}
{{- if .Values.redis.enabled }}redis{{ else }}memory{{ end -}}
{{- end -}}

{{/*
Postgres connection string. Lives in the Secret template as `stringData` so the
random per-run password never appears in values.yaml (which is a plain file in
the repo) — only in the in-cluster release Secret, inside a namespace that dies
with the preview.
*/}}
{{- define "vortex-preview.databaseUrl" -}}
postgresql://{{ .Values.postgres.user }}:{{ .Values.postgres.password }}@{{ include "vortex-preview.pgHost" . }}:5432/{{ .Values.postgres.database }}?schema=public
{{- end -}}
