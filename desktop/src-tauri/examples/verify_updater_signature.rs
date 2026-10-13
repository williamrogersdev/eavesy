use std::{env, fs, io::Read, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

fn decode_wrapped_file(path: &Path, label: &str) -> Result<String, String> {
    let encoded = fs::read_to_string(path)
        .map_err(|error| format!("could not read {label} {}: {error}", path.display()))?;
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("could not decode {label} {}: {error}", path.display()))?;
    String::from_utf8(decoded)
        .map_err(|error| format!("{label} {} is not UTF-8: {error}", path.display()))
}

fn main() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let archive = args
        .next()
        .ok_or("usage: verify_updater_signature <archive> <signature> <tauri.conf.json>")?;
    let signature_path = args
        .next()
        .ok_or("usage: verify_updater_signature <archive> <signature> <tauri.conf.json>")?;
    let config_path = args
        .next()
        .ok_or("usage: verify_updater_signature <archive> <signature> <tauri.conf.json>")?;
    if args.next().is_some() {
        return Err(
            "usage: verify_updater_signature <archive> <signature> <tauri.conf.json>".into(),
        );
    }

    let config_bytes = fs::read(&config_path).map_err(|error| {
        format!(
            "could not read Tauri config {}: {error}",
            Path::new(&config_path).display()
        )
    })?;
    let config: serde_json::Value = serde_json::from_slice(&config_bytes)
        .map_err(|error| format!("could not parse Tauri config: {error}"))?;
    let wrapped_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or("Tauri config has no plugins.updater.pubkey string")?;
    let public_key_file = STANDARD
        .decode(wrapped_public_key)
        .map_err(|error| format!("could not decode configured updater public key: {error}"))?;
    let public_key_file = String::from_utf8(public_key_file)
        .map_err(|error| format!("configured updater public key is not UTF-8: {error}"))?;
    let public_key_base64 = public_key_file
        .lines()
        .nth(1)
        .ok_or("configured updater public key is not a Minisign public-key file")?;
    let public_key = PublicKey::from_base64(public_key_base64)
        .map_err(|error| format!("configured updater public key is invalid: {error}"))?;

    let signature_file = decode_wrapped_file(Path::new(&signature_path), "updater signature")?;
    let signature = Signature::decode(&signature_file)
        .map_err(|error| format!("updater signature is invalid: {error}"))?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|error| format!("could not initialize updater verification: {error}"))?;
    let mut archive_file = fs::File::open(&archive).map_err(|error| {
        format!(
            "could not read updater archive {}: {error}",
            Path::new(&archive).display()
        )
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = archive_file
            .read(&mut buffer)
            .map_err(|error| format!("could not read updater archive: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }
    verifier
        .finalize()
        .map_err(|error| format!("updater signature does not match compiled public key: {error}"))?;

    println!("Updater signature matches the public key compiled into Eavesy.");
    Ok(())
}
