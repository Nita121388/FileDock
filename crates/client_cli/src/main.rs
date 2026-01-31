use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "filedock", version, about = "FileDock CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print a basic JSON structure used by the protocol crate.
    HealthSample,
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Command::HealthSample => {
            let resp = filedock_protocol::HealthResponse {
                status: "ok".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            };
            println!("{}", serde_json::to_string_pretty(&resp).unwrap());
        }
    }
}
