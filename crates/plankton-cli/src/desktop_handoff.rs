use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use plankton_core::{AccessRequest, ApprovalStatus};

const DESKTOP_HANDOFF_URL_PREFIX: &str = "plankton://review";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopHandoff {
    request_id: String,
}

impl DesktopHandoff {
    pub fn from_request(request: &AccessRequest) -> Option<Self> {
        (request.approval_status == ApprovalStatus::Pending).then(|| Self {
            request_id: request.id.clone(),
        })
    }

    pub fn deep_link_url(&self) -> String {
        format!(
            "{DESKTOP_HANDOFF_URL_PREFIX}?request_id={}",
            self.request_id
        )
    }
}

pub trait DesktopHandoffLauncher {
    fn launch(&self, handoff: &DesktopHandoff) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct SystemDesktopHandoffLauncher;

impl DesktopHandoffLauncher for SystemDesktopHandoffLauncher {
    fn launch(&self, handoff: &DesktopHandoff) -> Result<()> {
        launch_handoff_url(&handoff.deep_link_url())
    }
}

pub fn maybe_trigger_desktop_handoff(request: &AccessRequest) -> Result<bool> {
    maybe_trigger_desktop_handoff_with(request, &SystemDesktopHandoffLauncher)
}

fn maybe_trigger_desktop_handoff_with<L>(request: &AccessRequest, launcher: &L) -> Result<bool>
where
    L: DesktopHandoffLauncher,
{
    let Some(handoff) = DesktopHandoff::from_request(request) else {
        return Ok(false);
    };

    launcher.launch(&handoff).with_context(|| {
        format!(
            "request {} was submitted, but desktop handoff failed",
            request.id
        )
    })?;

    Ok(true)
}

fn launch_handoff_url(url: &str) -> Result<()> {
    let mut command = platform_handoff_command(url);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .with_context(|| format!("failed to launch desktop handoff URL {url}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_handoff_command(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn platform_handoff_command(url: &str) -> Command {
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", url]);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_handoff_command(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use plankton_core::{ApprovalStatus, Decision, PolicyMode, RequestContext};

    #[derive(Default)]
    struct RecordingLauncher {
        request_ids: RefCell<Vec<String>>,
    }

    impl DesktopHandoffLauncher for RecordingLauncher {
        fn launch(&self, handoff: &DesktopHandoff) -> Result<()> {
            self.request_ids
                .borrow_mut()
                .push(handoff.request_id.clone());
            Ok(())
        }
    }

    struct FailingLauncher;

    impl DesktopHandoffLauncher for FailingLauncher {
        fn launch(&self, _handoff: &DesktopHandoff) -> Result<()> {
            anyhow::bail!("launcher unavailable")
        }
    }

    #[test]
    fn pending_request_triggers_desktop_handoff() {
        let request = pending_request(PolicyMode::ManualOnly);
        let launcher = RecordingLauncher::default();

        let triggered = maybe_trigger_desktop_handoff_with(&request, &launcher)
            .expect("pending request should trigger handoff");

        assert!(triggered);
        assert_eq!(
            launcher.request_ids.borrow().as_slice(),
            &[request.id.clone()]
        );
    }

    #[test]
    fn auto_allow_request_does_not_trigger_desktop_handoff() {
        let mut request = pending_request(PolicyMode::LlmAutomatic);
        request.approval_status = ApprovalStatus::Approved;
        request.final_decision = Some(Decision::Allow);
        let launcher = RecordingLauncher::default();

        let triggered = maybe_trigger_desktop_handoff_with(&request, &launcher)
            .expect("resolved request should skip handoff");

        assert!(!triggered);
        assert!(launcher.request_ids.borrow().is_empty());
    }

    #[test]
    fn auto_deny_request_does_not_trigger_desktop_handoff() {
        let mut request = pending_request(PolicyMode::LlmAutomatic);
        request.approval_status = ApprovalStatus::Rejected;
        request.final_decision = Some(Decision::Deny);
        let launcher = RecordingLauncher::default();

        let triggered = maybe_trigger_desktop_handoff_with(&request, &launcher)
            .expect("resolved request should skip handoff");

        assert!(!triggered);
        assert!(launcher.request_ids.borrow().is_empty());
    }

    #[test]
    fn handoff_uses_request_id_only_deep_link_payload() {
        let request = pending_request(PolicyMode::Assisted);
        let handoff =
            DesktopHandoff::from_request(&request).expect("pending request should hand off");

        assert_eq!(
            handoff.deep_link_url(),
            format!("plankton://review?request_id={}", request.id)
        );
    }

    #[test]
    fn pending_request_surfaces_launcher_failures() {
        let request = pending_request(PolicyMode::Assisted);
        let error = maybe_trigger_desktop_handoff_with(&request, &FailingLauncher)
            .expect_err("handoff failure should bubble up");

        assert!(error.to_string().contains("request"));
        assert!(error.to_string().contains("desktop handoff failed"));
    }

    fn pending_request(policy_mode: PolicyMode) -> AccessRequest {
        AccessRequest::new_pending(
            RequestContext::new(
                "secret/api-token".to_string(),
                "Need smoke test access".to_string(),
                "alice".to_string(),
            ),
            policy_mode,
            None,
            String::new(),
            None,
            None,
        )
    }
}
