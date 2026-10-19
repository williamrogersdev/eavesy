fn main() {
    println!("cargo:rerun-if-env-changed=EAVESY_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=EAVESY_POSTHOG_HOST");

    tauri_build::build();
}
