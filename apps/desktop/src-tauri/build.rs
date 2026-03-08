use std::{env, path::PathBuf};

use serde_json::{json, Value};

fn merge_config(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                merge_config(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, patch) => *base = patch,
    }
}

fn sidecar_paths(manifest_dir: &str, target_triple: &str) -> Vec<PathBuf> {
    let ext = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    ["filedock", "filedock-sftp", "filedock-ssh"]
        .into_iter()
        .map(|name| {
            PathBuf::from(manifest_dir)
                .join("binaries")
                .join(format!("{name}-{target_triple}{ext}"))
        })
        .collect()
}

fn configure_dev_sidecars() {
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        return;
    }

    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(value) => value,
        Err(_) => return,
    };
    let target_triple = match env::var("TARGET") {
        Ok(value) => value,
        Err(_) => return,
    };

    let missing = sidecar_paths(&manifest_dir, &target_triple)
        .into_iter()
        .filter(|path| !path.exists())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return;
    }

    let mut config = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    merge_config(
        &mut config,
        json!({
            "bundle": {
                "externalBin": []
            }
        }),
    );
    env::set_var("TAURI_CONFIG", config.to_string());

    let missing_list = missing
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    println!(
        "cargo:warning=desktop sidecars missing for {profile}/{target_triple}; skipping bundle.externalBin ({missing_list})"
    );
    println!(
        "cargo:warning=run ./scripts/build-desktop-sidecars.sh before release packaging to bundle filedock sidecars"
    );
}

fn main() {
    configure_dev_sidecars();
    tauri_build::build()
}
