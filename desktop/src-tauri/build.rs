fn main() {
    // objc 0.2 macros expand this historical feature check in our crate.
    println!("cargo:rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");
    println!("cargo:rerun-if-env-changed=EAVESY_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=EAVESY_POSTHOG_HOST");

    tauri_build::build();
}
