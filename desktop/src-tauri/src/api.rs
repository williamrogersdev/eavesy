use serde::{Deserialize, Serialize};

const DEFAULT_BASE: &str = "https://eavesy.com";

pub struct Client {
    base: String,
    session_token: Option<String>,
}

impl Client {
    pub fn new() -> Self {
        let base = std::env::var("EAVESY_API_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_string());
        Self {
            base,
            session_token: None,
        }
    }

    pub fn set_session_token(&mut self, token: Option<String>) {
        self.session_token = token;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartMeetingRequest {
    pub source: String,
    pub title: Option<String>,
    pub local_folder_slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartMeetingResponse {
    pub meeting_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMeetingRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}
