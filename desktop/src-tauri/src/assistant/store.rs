//! The policy file: the permission mode, Bypass's expiry and the trusted folders.
//!
//! Any process running as you can write a file in your home folder, Claude Code in
//! Bypass included. So the file carries an HMAC whose key lives in the Keychain, and
//! only Eavesy's own UI writes it. A file that fails the check loads as Ask, and the
//! app says the rules changed outside Eavesy (assistant.md C8).
//!
//! The MAC alone would let an agent copy the file while Bypass is on and put the copy
//! back later. So the Keychain also holds the MAC of the last file Eavesy wrote, and
//! only that file loads.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::policy::{Effective, Mode};

/// What the user chose in Eavesy's UI.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default)]
    pub mode: Mode,
    /// Unix ms when Bypass (or Auto) falls back to Ask; `None` is "until I turn it off".
    #[serde(default)]
    pub until_ms: Option<u64>,
    #[serde(default)]
    pub trusted_folders: Vec<PathBuf>,
}

impl Policy {
    /// The mode in force at `now_ms`: an expired mode is Ask.
    pub fn effective(&self, now_ms: u64) -> Effective {
        let expired = self.until_ms.is_some_and(|until| now_ms >= until);
        Effective {
            mode: if expired { Mode::Ask } else { self.mode },
            trusted_folders: self.trusted_folders.clone(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Signed {
    policy: Policy,
    /// Hex HMAC-SHA256 of the policy's canonical JSON.
    mac: String,
}

/// How the file loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Loaded {
    /// No file yet: Ask.
    Missing,
    Valid(Policy),
    /// The file changed outside Eavesy, or its key is gone. Treated as Ask until you look.
    Tampered,
}

impl Loaded {
    pub fn policy(&self) -> Policy {
        match self {
            Loaded::Valid(policy) => policy.clone(),
            Loaded::Missing | Loaded::Tampered => Policy::default(),
        }
    }
}

/// Where the signing key and the last MAC live. A trait so tests don't touch the Keychain.
pub trait KeyStore {
    fn key(&self) -> Result<Option<Vec<u8>>, String>;
    fn create_key(&self) -> Result<Vec<u8>, String>;
    /// The MAC of the last policy Eavesy saved.
    fn latest(&self) -> Result<Option<String>, String>;
    fn set_latest(&self, mac: &str) -> Result<(), String>;
}

pub fn path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Eavesy").join("assistant").join("policy.json"))
}

pub fn load(file: &Path, keys: &impl KeyStore) -> Loaded {
    let Ok(text) = std::fs::read_to_string(file) else { return Loaded::Missing };
    let Ok(signed) = serde_json::from_str::<Signed>(&text) else { return Loaded::Tampered };
    let Ok(Some(key)) = keys.key() else { return Loaded::Tampered };
    let Ok(body) = serde_json::to_vec(&signed.policy) else { return Loaded::Tampered };
    let Ok(Some(latest)) = keys.latest() else { return Loaded::Tampered };
    let mac = hex::encode(hmac_sha256(&key, &body));
    if constant_time_eq(mac.as_bytes(), signed.mac.as_bytes()) && constant_time_eq(mac.as_bytes(), latest.as_bytes()) {
        Loaded::Valid(signed.policy)
    } else {
        Loaded::Tampered
    }
}

/// Signs and writes the policy atomically (a partial file, then a rename), owner-only.
pub fn save(file: &Path, keys: &impl KeyStore, policy: &Policy) -> Result<(), String> {
    let key = match keys.key()? {
        Some(key) => key,
        None => keys.create_key()?,
    };
    let body = serde_json::to_vec(policy).map_err(|e| e.to_string())?;
    let mac = hex::encode(hmac_sha256(&key, &body));
    let signed = Signed { policy: policy.clone(), mac: mac.clone() };
    let text = serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?;
    let dir = file.parent().ok_or("the policy file has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let partial = file.with_extension("json.partial");
    write_private(&partial, text.as_bytes())?;
    // The Keychain first: if the rename then fails, the old file no longer matches and
    // loads as Ask, which is the safe way to be wrong.
    keys.set_latest(&mac)?;
    std::fs::rename(&partial, file).map_err(|e| format!("couldn't save the policy: {e}"))
}

fn write_private(file: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut out = options.open(file).map_err(|e| format!("couldn't write {}: {e}", file.display()))?;
    out.write_all(bytes).and_then(|()| out.sync_all()).map_err(|e| format!("couldn't write {}: {e}", file.display()))
}

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The signing key in the macOS Keychain, created on first save.
#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
impl KeyStore for Keychain {
    fn key(&self) -> Result<Option<Vec<u8>>, String> {
        match keychain_read(KEY_ACCOUNT)? {
            Some(bytes) => hex::decode(bytes).map(Some).map_err(|_| "the policy key is damaged".to_string()),
            None => Ok(None),
        }
    }

    fn latest(&self) -> Result<Option<String>, String> {
        keychain_read(LATEST_ACCOUNT)?.map(|bytes| String::from_utf8(bytes).map_err(|_| "the policy check is damaged".to_string())).transpose()
    }

    fn set_latest(&self, mac: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(KEY_SERVICE, LATEST_ACCOUNT, mac.as_bytes())
            .map_err(|error| format!("couldn't save the policy check in Keychain: {error}"))
    }

    fn create_key(&self) -> Result<Vec<u8>, String> {
        let key: Vec<u8> = uuid::Uuid::new_v4().as_bytes().iter().chain(uuid::Uuid::new_v4().as_bytes()).copied().collect();
        security_framework::passwords::set_generic_password(KEY_SERVICE, KEY_ACCOUNT, hex::encode(&key).as_bytes())
            .map_err(|error| format!("couldn't save the policy key in Keychain: {error}"))?;
        Ok(key)
    }
}

#[cfg(target_os = "macos")]
fn keychain_read(account: &str) -> Result<Option<Vec<u8>>, String> {
    const ITEM_NOT_FOUND: i32 = -25300;
    match security_framework::passwords::get_generic_password(KEY_SERVICE, account) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(format!("Keychain read failed: {error}")),
    }
}

#[cfg(target_os = "macos")]
const KEY_SERVICE: &str = "com.eavesy.desktop.assistant-policy.v1";
#[cfg(target_os = "macos")]
const KEY_ACCOUNT: &str = "policy";
#[cfg(target_os = "macos")]
const LATEST_ACCOUNT: &str = "latest";

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Memory(RefCell<Option<Vec<u8>>>, RefCell<Option<String>>);

    impl KeyStore for Memory {
        fn key(&self) -> Result<Option<Vec<u8>>, String> { Ok(self.0.borrow().clone()) }
        fn create_key(&self) -> Result<Vec<u8>, String> {
            let key = vec![7u8; 32];
            *self.0.borrow_mut() = Some(key.clone());
            Ok(key)
        }
        fn latest(&self) -> Result<Option<String>, String> { Ok(self.1.borrow().clone()) }
        fn set_latest(&self, mac: &str) -> Result<(), String> {
            *self.1.borrow_mut() = Some(mac.into());
            Ok(())
        }
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eavesy-policy-{}", uuid::Uuid::new_v4()));
        dir.join("policy.json")
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex::encode(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn a_saved_policy_loads_back() {
        let (file, keys) = (temp(), Memory::default());
        assert_eq!(load(&file, &keys), Loaded::Missing);
        let policy = Policy { mode: Mode::Bypass, until_ms: Some(10), trusted_folders: vec!["/a".into()] };
        save(&file, &keys, &policy).unwrap();
        assert_eq!(load(&file, &keys), Loaded::Valid(policy));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn an_edit_outside_eavesy_loads_as_ask() {
        let (file, keys) = (temp(), Memory::default());
        save(&file, &keys, &Policy::default()).unwrap();
        let edited = std::fs::read_to_string(&file).unwrap().replace("\"ask\"", "\"bypass\"");
        std::fs::write(&file, edited).unwrap();
        let loaded = load(&file, &keys);
        assert_eq!(loaded, Loaded::Tampered);
        assert_eq!(loaded.policy().mode, Mode::Ask);
    }

    #[test]
    fn a_missing_key_loads_as_ask() {
        let (file, keys) = (temp(), Memory::default());
        save(&file, &keys, &Policy { mode: Mode::Auto, ..Policy::default() }).unwrap();
        assert_eq!(load(&file, &Memory::default()), Loaded::Tampered);
    }

    #[test]
    fn an_old_copy_put_back_loads_as_ask() {
        let (file, keys) = (temp(), Memory::default());
        save(&file, &keys, &Policy { mode: Mode::Bypass, until_ms: None, trusted_folders: vec!["/a".into()] }).unwrap();
        let copy = std::fs::read(&file).unwrap();
        save(&file, &keys, &Policy::default()).unwrap();
        std::fs::write(&file, copy).unwrap();
        assert_eq!(load(&file, &keys), Loaded::Tampered);
    }

    #[test]
    fn an_expired_mode_is_ask() {
        let policy = Policy { mode: Mode::Bypass, until_ms: Some(100), trusted_folders: vec![] };
        assert_eq!(policy.effective(99).mode, Mode::Bypass);
        assert_eq!(policy.effective(100).mode, Mode::Ask);
        assert_eq!(Policy { until_ms: None, ..policy }.effective(u64::MAX).mode, Mode::Bypass);
    }
}
