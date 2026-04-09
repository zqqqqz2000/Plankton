use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use agent_client_protocol::{self as acp, Agent as _};
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

use crate::{PlanktonSettings, ProviderError, ProviderTrace};

pub const ACP_CODEX_PROVIDER_KIND: &str = "acp_codex";
pub const ACP_CODEX_PACKAGE_NAME: &str = "@zed-industries/codex-acp";
pub const ACP_CODEX_PACKAGE_VERSION: &str = "0.11.1";
pub const ACP_TRANSPORT_STDIO: &str = "stdio";

#[derive(Debug, Clone)]
pub struct AcpSessionConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub timeout: Duration,
    pub client_name: String,
    pub client_version: String,
    pub package_name: String,
    pub package_version: String,
    pub transport: String,
}

impl AcpSessionConfig {
    pub fn from_settings(settings: &PlanktonSettings) -> Result<Self, ProviderError> {
        let program = settings.acp_codex_program.trim();
        if program.is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_ACP_CODEX_PROGRAM must be set for acp_codex".to_string(),
            ));
        }

        let args = shell_words::split(settings.acp_codex_args.trim())
            .map_err(|error| ProviderError::Config(format!("invalid ACP args: {error}")))?;
        if args.is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_ACP_CODEX_ARGS must contain the codex-acp package invocation".to_string(),
            ));
        }

        let cwd = std::env::current_dir()
            .map_err(|error| ProviderError::Transport(format!("failed to resolve cwd: {error}")))?
            .canonicalize()
            .map_err(|error| {
                ProviderError::Transport(format!("failed to canonicalize cwd: {error}"))
            })?;

        Ok(Self {
            program: program.to_string(),
            args,
            cwd,
            timeout: Duration::from_secs(settings.acp_timeout_secs.max(1)),
            client_name: "plankton".to_string(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            package_name: ACP_CODEX_PACKAGE_NAME.to_string(),
            package_version: ACP_CODEX_PACKAGE_VERSION.to_string(),
            transport: ACP_TRANSPORT_STDIO.to_string(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct AcpPromptResult {
    pub content: String,
    pub provider_model: Option<String>,
    pub trace: ProviderTrace,
}

#[derive(Debug, Clone)]
pub struct AcpSessionClient {
    config: AcpSessionConfig,
}

impl AcpSessionClient {
    pub fn new(config: AcpSessionConfig) -> Self {
        Self { config }
    }

    pub fn from_settings(settings: &PlanktonSettings) -> Result<Self, ProviderError> {
        Ok(Self::new(AcpSessionConfig::from_settings(settings)?))
    }

    pub async fn prompt_json_suggestion(
        &self,
        prompt: String,
    ) -> Result<AcpPromptResult, ProviderError> {
        let config = self.config.clone();
        tokio::task::spawn_blocking(move || run_acp_prompt_blocking(config, prompt))
            .await
            .map_err(|error| {
                ProviderError::Transport(format!("ACP prompt task failed to join: {error}"))
            })?
    }
}

#[derive(Debug, Clone, Default)]
struct AcpSessionState {
    content: String,
    permission_requested: bool,
    tool_call_seen: bool,
    non_text_content_seen: bool,
}

#[derive(Debug, Clone, Default)]
struct AcpClientHandler {
    state: Arc<Mutex<AcpSessionState>>,
}

impl AcpClientHandler {
    fn snapshot(&self) -> Result<AcpSessionState, ProviderError> {
        self.state.lock().map(|state| state.clone()).map_err(|_| {
            ProviderError::Transport("ACP session state mutex was poisoned".to_string())
        })
    }
}

#[async_trait::async_trait(?Send)]
impl acp::Client for AcpClientHandler {
    async fn request_permission(
        &self,
        _args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        if let Ok(mut state) = self.state.lock() {
            state.permission_requested = true;
        }

        Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Cancelled,
        ))
    }

    async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
        if let Ok(mut state) = self.state.lock() {
            match args.update {
                acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk { content, .. }) => {
                    if let acp::ContentBlock::Text(text) = content {
                        state.content.push_str(&text.text);
                    } else {
                        state.non_text_content_seen = true;
                    }
                }
                acp::SessionUpdate::ToolCall(_) | acp::SessionUpdate::ToolCallUpdate(_) => {
                    state.tool_call_seen = true;
                }
                _ => {}
            }
        }

        Ok(())
    }
}

fn run_acp_prompt_blocking(
    config: AcpSessionConfig,
    prompt: String,
) -> Result<AcpPromptResult, ProviderError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            ProviderError::Transport(format!("failed to build ACP runtime: {error}"))
        })?;
    let local_set = tokio::task::LocalSet::new();

    runtime.block_on(local_set.run_until(async move {
        let mut child = Command::new(&config.program)
            .args(&config.args)
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                ProviderError::Transport(format!("failed to spawn ACP agent process: {error}"))
            })?;
        let outgoing = child
            .stdin
            .take()
            .ok_or_else(|| ProviderError::Transport("ACP agent stdin was unavailable".to_string()))?
            .compat_write();
        let incoming = child
            .stdout
            .take()
            .ok_or_else(|| {
                ProviderError::Transport("ACP agent stdout was unavailable".to_string())
            })?
            .compat();

        let result = run_acp_prompt_local(config, outgoing, incoming, prompt).await;
        drop(child);
        result
    }))
}

async fn run_acp_prompt_local(
    config: AcpSessionConfig,
    outgoing: impl futures::AsyncWrite + Unpin + 'static,
    incoming: impl futures::AsyncRead + Unpin + 'static,
    prompt: String,
) -> Result<AcpPromptResult, ProviderError> {
    let handler = AcpClientHandler::default();
    let handler_for_conn = handler.clone();
    let (conn, handle_io) =
        acp::ClientSideConnection::new(handler_for_conn, outgoing, incoming, |future| {
            tokio::task::spawn_local(future);
        });
    tokio::task::spawn_local(async move {
        let _ = handle_io.await;
    });

    let client_request_id = Uuid::new_v4().to_string();
    let initialize_response = timeout(
        config.timeout,
        conn.initialize(
            acp::InitializeRequest::new(acp::ProtocolVersion::V1).client_info(
                acp::Implementation::new(&config.client_name, &config.client_version)
                    .title("Plankton ACP Client"),
            ),
        ),
    )
    .await
    .map_err(|_| ProviderError::Transport("ACP initialize timed out".to_string()))?
    .map_err(|error| ProviderError::Transport(format!("ACP initialize failed: {error}")))?;

    let session_response = timeout(
        config.timeout,
        conn.new_session(acp::NewSessionRequest::new(config.cwd.clone())),
    )
    .await
    .map_err(|_| ProviderError::Transport("ACP session/new timed out".to_string()))?
    .map_err(|error| ProviderError::Transport(format!("ACP session/new failed: {error}")))?;

    timeout(
        config.timeout,
        conn.prompt(acp::PromptRequest::new(
            session_response.session_id.clone(),
            vec![prompt.into()],
        )),
    )
    .await
    .map_err(|_| ProviderError::Transport("ACP session/prompt timed out".to_string()))?
    .map_err(|error| ProviderError::Transport(format!("ACP session/prompt failed: {error}")))?;

    let state = handler.snapshot()?;
    if state.permission_requested {
        return Err(ProviderError::Transport(
            "ACP agent requested permission; suggestion-only path fail-closed".to_string(),
        ));
    }
    if state.tool_call_seen {
        return Err(ProviderError::Transport(
            "ACP agent attempted a tool or MCP call; suggestion-only path fail-closed".to_string(),
        ));
    }
    if state.non_text_content_seen {
        return Err(ProviderError::InvalidResponse(
            "ACP agent returned non-text content instead of a strict JSON suggestion".to_string(),
        ));
    }

    let content = state.content.trim().to_string();
    if content.is_empty() {
        return Err(ProviderError::EmptyResponse);
    }

    let initialize_json = serde_json::to_value(&initialize_response).map_err(|error| {
        ProviderError::Transport(format!(
            "failed to serialize ACP initialize response: {error}"
        ))
    })?;
    let agent_name = read_json_string(&initialize_json, &["/agentInfo/name", "/agent_info/name"]);
    let agent_version = read_json_string(
        &initialize_json,
        &["/agentInfo/version", "/agent_info/version"],
    );
    let provider_model = build_provider_model(agent_name.as_deref(), agent_version.as_deref());

    Ok(AcpPromptResult {
        content,
        provider_model,
        trace: ProviderTrace {
            transport: Some(config.transport),
            protocol: None,
            api_version: None,
            output_format: None,
            stop_reason: None,
            package_name: Some(config.package_name),
            package_version: Some(config.package_version),
            session_id: Some(session_response.session_id.to_string()),
            client_request_id: Some(client_request_id),
            agent_name,
            agent_version,
            beta_headers: Vec::new(),
        },
    })
}

fn read_json_string(value: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(|inner| inner.as_str())
            .map(ToOwned::to_owned)
    })
}

fn build_provider_model(agent_name: Option<&str>, agent_version: Option<&str>) -> Option<String> {
    match (agent_name, agent_version) {
        (Some(name), Some(version)) if !name.trim().is_empty() && !version.trim().is_empty() => {
            Some(format!("{name}@{version}"))
        }
        (Some(name), _) if !name.trim().is_empty() => Some(name.to_string()),
        (_, Some(version)) if !version.trim().is_empty() => Some(version.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use agent_client_protocol::Client as _;
    use tokio::sync::{mpsc, oneshot};

    use super::*;

    struct MockAgent {
        session_update_tx: mpsc::UnboundedSender<(acp::SessionNotification, oneshot::Sender<()>)>,
        next_session_id: Cell<u64>,
        response_text: String,
        emit_tool_call: bool,
    }

    impl MockAgent {
        fn new(
            session_update_tx: mpsc::UnboundedSender<(
                acp::SessionNotification,
                oneshot::Sender<()>,
            )>,
            response_text: String,
            emit_tool_call: bool,
        ) -> Self {
            Self {
                session_update_tx,
                next_session_id: Cell::new(0),
                response_text,
                emit_tool_call,
            }
        }
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Agent for MockAgent {
        async fn initialize(
            &self,
            _arguments: acp::InitializeRequest,
        ) -> Result<acp::InitializeResponse, acp::Error> {
            Ok(
                acp::InitializeResponse::new(acp::ProtocolVersion::V1).agent_info(
                    acp::Implementation::new("mock-codex-acp", "0.11.1").title("Mock ACP Agent"),
                ),
            )
        }

        async fn authenticate(
            &self,
            _arguments: acp::AuthenticateRequest,
        ) -> Result<acp::AuthenticateResponse, acp::Error> {
            Ok(acp::AuthenticateResponse::default())
        }

        async fn new_session(
            &self,
            _arguments: acp::NewSessionRequest,
        ) -> Result<acp::NewSessionResponse, acp::Error> {
            let session_id = self.next_session_id.get();
            self.next_session_id.set(session_id + 1);
            Ok(acp::NewSessionResponse::new(session_id.to_string()))
        }

        async fn load_session(
            &self,
            _arguments: acp::LoadSessionRequest,
        ) -> Result<acp::LoadSessionResponse, acp::Error> {
            Ok(acp::LoadSessionResponse::new())
        }

        async fn prompt(
            &self,
            arguments: acp::PromptRequest,
        ) -> Result<acp::PromptResponse, acp::Error> {
            if self.emit_tool_call {
                let (tx, rx) = oneshot::channel();
                self.session_update_tx
                    .send((
                        acp::SessionNotification::new(
                            arguments.session_id.clone(),
                            acp::SessionUpdate::ToolCall(acp::ToolCall::new(
                                acp::ToolCallId::new("tool-1"),
                                "Mock tool call",
                            )),
                        ),
                        tx,
                    ))
                    .map_err(|_| acp::Error::internal_error())?;
                rx.await.map_err(|_| acp::Error::internal_error())?;
            }

            let (tx, rx) = oneshot::channel();
            self.session_update_tx
                .send((
                    acp::SessionNotification::new(
                        arguments.session_id,
                        acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                            self.response_text.clone().into(),
                        )),
                    ),
                    tx,
                ))
                .map_err(|_| acp::Error::internal_error())?;
            rx.await.map_err(|_| acp::Error::internal_error())?;

            Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
        }

        async fn cancel(&self, _args: acp::CancelNotification) -> Result<(), acp::Error> {
            Ok(())
        }

        async fn set_session_mode(
            &self,
            _args: acp::SetSessionModeRequest,
        ) -> Result<acp::SetSessionModeResponse, acp::Error> {
            Ok(acp::SetSessionModeResponse::default())
        }

        async fn set_session_config_option(
            &self,
            _args: acp::SetSessionConfigOptionRequest,
        ) -> Result<acp::SetSessionConfigOptionResponse, acp::Error> {
            Ok(acp::SetSessionConfigOptionResponse::new(Vec::new()))
        }
    }

    async fn run_mock_prompt(
        response_text: &str,
        emit_tool_call: bool,
    ) -> Result<AcpPromptResult, ProviderError> {
        let local_set = tokio::task::LocalSet::new();
        local_set
            .run_until(async move {
                let (client_to_agent_tx, client_to_agent_rx) = tokio::io::duplex(16 * 1024);
                let (agent_to_client_tx, agent_to_client_rx) = tokio::io::duplex(16 * 1024);
                let (client_outgoing, client_incoming) = (
                    client_to_agent_tx.compat_write(),
                    agent_to_client_rx.compat(),
                );
                let (agent_outgoing, agent_incoming) = (
                    agent_to_client_tx.compat_write(),
                    client_to_agent_rx.compat(),
                );
                let (update_tx, mut update_rx) = mpsc::unbounded_channel();
                let (agent_conn, agent_io) = acp::AgentSideConnection::new(
                    MockAgent::new(update_tx, response_text.to_string(), emit_tool_call),
                    agent_outgoing,
                    agent_incoming,
                    |future| {
                        tokio::task::spawn_local(future);
                    },
                );
                tokio::task::spawn_local(async move {
                    while let Some((notification, tx)) = update_rx.recv().await {
                        let _ = agent_conn.session_notification(notification).await;
                        let _ = tx.send(());
                    }
                });
                tokio::task::spawn_local(async move {
                    let _ = agent_io.await;
                });

                let config = AcpSessionConfig {
                    program: "mock".to_string(),
                    args: Vec::new(),
                    cwd: std::env::current_dir().expect("cwd"),
                    timeout: Duration::from_secs(5),
                    client_name: "plankton".to_string(),
                    client_version: "0.1.0".to_string(),
                    package_name: ACP_CODEX_PACKAGE_NAME.to_string(),
                    package_version: ACP_CODEX_PACKAGE_VERSION.to_string(),
                    transport: ACP_TRANSPORT_STDIO.to_string(),
                };

                run_acp_prompt_local(
                    config,
                    client_outgoing,
                    client_incoming,
                    "Return strict JSON".to_string(),
                )
                .await
            })
            .await
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acp_session_client_collects_json_text_and_trace() {
        let result = run_mock_prompt(
            "{\"suggested_decision\":\"allow\",\"rationale_summary\":\"safe enough\",\"risk_score\":12}",
            false,
        )
        .await
        .expect("ACP prompt should succeed");

        assert!(result.content.contains("\"suggested_decision\":\"allow\""));
        assert_eq!(
            result.provider_model.as_deref(),
            Some("mock-codex-acp@0.11.1")
        );
        assert_eq!(
            result.trace.package_name.as_deref(),
            Some(ACP_CODEX_PACKAGE_NAME)
        );
        assert_eq!(result.trace.transport.as_deref(), Some(ACP_TRANSPORT_STDIO));
        assert_eq!(result.trace.agent_name.as_deref(), Some("mock-codex-acp"));
        assert_eq!(result.trace.agent_version.as_deref(), Some("0.11.1"));
        assert_eq!(result.trace.session_id.as_deref(), Some("0"));
        assert!(result.trace.client_request_id.is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acp_session_client_fails_closed_on_tool_calls() {
        let error = run_mock_prompt(
            "{\"suggested_decision\":\"allow\",\"rationale_summary\":\"safe enough\",\"risk_score\":12}",
            true,
        )
        .await
        .expect_err("tool calls must fail closed");

        assert!(
            error
                .to_string()
                .contains("suggestion-only path fail-closed"),
            "unexpected error: {error}"
        );
    }
}
