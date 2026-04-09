export type RequestContext = {
  resource: string;
  reason: string;
  requested_by: string;
  script_path: string | null;
  call_chain: string[];
  env_vars: Record<string, string>;
  metadata: Record<string, string>;
  created_at: string;
};

export type LlmSuggestionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ProviderTrace = {
  transport: string | null;
  protocol: string | null;
  api_version: string | null;
  output_format: string | null;
  stop_reason: string | null;
  package_name: string | null;
  package_version: string | null;
  session_id: string | null;
  client_request_id: string | null;
  agent_name: string | null;
  agent_version: string | null;
  beta_headers: string[];
};

export type LlmSuggestion = {
  template_id: string;
  template_version: string;
  prompt_contract_version: string;
  prompt_sha256: string;
  suggested_decision: string;
  rationale_summary: string;
  risk_score: number;
  provider_kind: string;
  provider_model: string | null;
  provider_response_id: string | null;
  x_request_id: string | null;
  provider_trace: ProviderTrace | null;
  usage: LlmSuggestionUsage | null;
  error: string | null;
  generated_at: string;
};

export type AutomaticDecisionTrace = {
  auto_disposition: string;
  decision_source: string;
  matched_rule_ids: string[];
  secret_exposure_risk: boolean;
  provider_called: boolean;
  suggested_decision: string | null;
  risk_score: number | null;
  template_id: string | null;
  template_version: string | null;
  prompt_contract_version: string | null;
  provider_kind: string | null;
  provider_model: string | null;
  x_request_id: string | null;
  provider_response_id: string | null;
  redacted_fields: string[];
  redaction_summary: string;
  auto_rationale_summary: string;
  fail_closed: boolean;
  evaluated_at: string;
};

export type AccessRequest = {
  id: string;
  context: RequestContext;
  policy_mode: string;
  approval_status: string;
  final_decision: string | null;
  provider_kind: string | null;
  rendered_prompt: string;
  llm_suggestion: LlmSuggestion | null;
  automatic_decision: AutomaticDecisionTrace | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type AuditRecord = {
  id: string;
  request_id: string;
  action: string;
  actor: string;
  note: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type DashboardData = {
  pending_requests: AccessRequest[];
  recent_audit_records: AuditRecord[];
};

export type DecisionCommand = "approve_request" | "reject_request";
