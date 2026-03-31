use std::process::Command;
use std::path::Path;

fn main() {
    let ui_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");

    // Re-run if any source file changes
    println!("cargo:rerun-if-changed=ui/panel/main.js");
    println!("cargo:rerun-if-changed=ui/config/main.js");
    println!("cargo:rerun-if-changed=ui/shared/icons.js");
    println!("cargo:rerun-if-changed=ui/panel/index.html");
    println!("cargo:rerun-if-changed=ui/panel/panel.css");
    println!("cargo:rerun-if-changed=ui/config/index.html");
    println!("cargo:rerun-if-changed=ui/config/config.css");
    println!("cargo:rerun-if-changed=ui/package.json");

    // Install node_modules if missing
    if !ui_dir.join("node_modules").exists() {
        let status = Command::new("npm")
            .arg("install")
            .arg("--silent")
            .current_dir(&ui_dir)
            .status()
            .expect("failed to run npm install — is Node.js installed?");

        if !status.success() {
            panic!("npm install failed");
        }
    }

    // Run the esbuild bundle
    let status = Command::new("node")
        .arg("build.mjs")
        .current_dir(&ui_dir)
        .status()
        .expect("failed to run node build.mjs — is Node.js installed?");

    if !status.success() {
        panic!("UI build failed");
    }
}
