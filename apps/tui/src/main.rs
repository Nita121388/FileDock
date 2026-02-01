use clap::Parser;
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use filedock_protocol::{SnapshotMeta, TreeEntry, TreeResponse};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Terminal,
};
use std::{io, time::Duration};

const TOKEN_HEADER: &str = "x-filedock-token";

#[derive(Parser, Debug)]
#[command(name = "filedock-tui", version, about = "FileDock terminal UI (MVP)")]
struct Args {
    /// Server base URL, e.g. http://127.0.0.1:8787
    #[arg(long, default_value = "http://127.0.0.1:8787")]
    server: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Focus {
    Snapshots,
    Tree,
}

struct App {
    focus: Focus,
    status: String,

    snapshots: Vec<SnapshotMeta>,
    snapshots_state: ListState,

    snapshot_id: Option<String>,
    path: String,
    entries: Vec<TreeEntry>,
    tree_state: ListState,
}

impl App {
    fn new() -> Self {
        let mut snapshots_state = ListState::default();
        snapshots_state.select(Some(0));

        let mut tree_state = ListState::default();
        tree_state.select(Some(0));

        Self {
            focus: Focus::Snapshots,
            status: "q:quit  r:refresh  tab:switch  enter:open  b/backspace:up".to_string(),
            snapshots: Vec::new(),
            snapshots_state,
            snapshot_id: None,
            path: String::new(),
            entries: Vec::new(),
            tree_state,
        }
    }

    fn selected_snapshot(&self) -> Option<&SnapshotMeta> {
        let i = self.snapshots_state.selected()?;
        self.snapshots.get(i)
    }

    fn selected_entry(&self) -> Option<&TreeEntry> {
        let i = self.tree_state.selected()?;
        self.entries.get(i)
    }

    fn select_next(state: &mut ListState, len: usize) {
        if len == 0 {
            state.select(None);
            return;
        }
        let next = match state.selected() {
            None => 0,
            Some(i) => (i + 1).min(len - 1),
        };
        state.select(Some(next));
    }

    fn select_prev(state: &mut ListState, len: usize) {
        if len == 0 {
            state.select(None);
            return;
        }
        let prev = match state.selected() {
            None => 0,
            Some(i) => i.saturating_sub(1),
        };
        state.select(Some(prev));
    }

    fn reset_tree(&mut self) {
        self.entries.clear();
        self.path.clear();
        self.snapshot_id = None;
        self.tree_state.select(Some(0));
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    // If FILEDOCK_TOKEN is set, attach it to all requests.
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(token) = std::env::var("FILEDOCK_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
            let value = reqwest::header::HeaderValue::from_str(&token)
                .map_err(|e| format!("invalid FILEDOCK_TOKEN: {e}"))?;
            headers.insert(name, value);
        }
    }

    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

async fn fetch_snapshots(client: &reqwest::Client, server: &str) -> Result<Vec<SnapshotMeta>, String> {
    let url = format!("{}/v1/snapshots", server.trim_end_matches('/'));
    let mut metas: Vec<SnapshotMeta> = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("snapshots request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("snapshots response: {e}"))?
        .json()
        .await
        .map_err(|e| format!("snapshots decode: {e}"))?;

    metas.sort_by(|a, b| b.created_unix.cmp(&a.created_unix));
    Ok(metas)
}

async fn fetch_tree(
    client: &reqwest::Client,
    server: &str,
    snapshot_id: &str,
    path: &str,
) -> Result<TreeResponse, String> {
    let url = format!(
        "{}/v1/snapshots/{}/tree",
        server.trim_end_matches('/'),
        snapshot_id
    );
    client
        .get(url)
        .query(&[("path", path)])
        .send()
        .await
        .map_err(|e| format!("tree request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("tree response: {e}"))?
        .json()
        .await
        .map_err(|e| format!("tree decode: {e}"))
}

fn main() -> Result<(), String> {
    let args = Args::parse();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    let client = build_client()?;

    enable_raw_mode().map_err(|e| format!("enable raw mode: {e}"))?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen).map_err(|e| format!("enter alt screen: {e}"))?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).map_err(|e| format!("terminal init: {e}"))?;

    let res = run_app(&mut terminal, &rt, &client, &args.server);

    disable_raw_mode().map_err(|e| format!("disable raw mode: {e}"))?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)
        .map_err(|e| format!("leave alt screen: {e}"))?;
    terminal.show_cursor().map_err(|e| format!("show cursor: {e}"))?;

    res
}

fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    rt: &tokio::runtime::Runtime,
    client: &reqwest::Client,
    server: &str,
) -> Result<(), String> {
    let mut app = App::new();

    // Initial fetch.
    match rt.block_on(fetch_snapshots(client, server)) {
        Ok(s) => {
            app.snapshots = s;
            app.snapshots_state.select(if app.snapshots.is_empty() { None } else { Some(0) });
        }
        Err(e) => app.status = format!("error: {e}"),
    }

    loop {
        terminal
            .draw(|f| ui(f, &mut app))
            .map_err(|e| format!("draw: {e}"))?;

        if event::poll(Duration::from_millis(50)).map_err(|e| format!("event poll: {e}"))? {
            if let Event::Key(k) = event::read().map_err(|e| format!("event read: {e}"))? {
                match k.code {
                    KeyCode::Char('q') => return Ok(()),
                    KeyCode::Char('r') => {
                        match rt.block_on(fetch_snapshots(client, server)) {
                            Ok(s) => {
                                app.snapshots = s;
                                app.snapshots_state
                                    .select(if app.snapshots.is_empty() { None } else { Some(0) });
                                app.status = "snapshots refreshed".to_string();
                                // Refresh tree if currently showing one.
                                if let Some(id) = app.snapshot_id.clone() {
                                    match rt.block_on(fetch_tree(client, server, &id, &app.path)) {
                                        Ok(tr) => {
                                            app.entries = tr.entries;
                                            app.tree_state.select(if app.entries.is_empty() { None } else { Some(0) });
                                        }
                                        Err(e) => app.status = format!("error: {e}"),
                                    }
                                }
                            }
                            Err(e) => app.status = format!("error: {e}"),
                        }
                    }
                    KeyCode::Tab => {
                        app.focus = match app.focus {
                            Focus::Snapshots => Focus::Tree,
                            Focus::Tree => Focus::Snapshots,
                        }
                    }
                    KeyCode::Up => match app.focus {
                        Focus::Snapshots => App::select_prev(&mut app.snapshots_state, app.snapshots.len()),
                        Focus::Tree => App::select_prev(&mut app.tree_state, app.entries.len()),
                    },
                    KeyCode::Down => match app.focus {
                        Focus::Snapshots => App::select_next(&mut app.snapshots_state, app.snapshots.len()),
                        Focus::Tree => App::select_next(&mut app.tree_state, app.entries.len()),
                    },
                    KeyCode::Enter => match app.focus {
                        Focus::Snapshots => {
                            if let Some(s) = app.selected_snapshot() {
                                app.snapshot_id = Some(s.snapshot_id.clone());
                                app.path.clear();
                                match rt.block_on(fetch_tree(client, server, &s.snapshot_id, "")) {
                                    Ok(tr) => {
                                        app.entries = tr.entries;
                                        app.tree_state.select(if app.entries.is_empty() { None } else { Some(0) });
                                        app.status = format!("opened snapshot {}", s.snapshot_id);
                                    }
                                    Err(e) => app.status = format!("error: {e}"),
                                }
                                app.focus = Focus::Tree;
                            }
                        }
                        Focus::Tree => {
                            let Some(id) = app.snapshot_id.clone() else {
                                app.status = "select a snapshot first".to_string();
                                continue;
                            };
                            let Some(ent) = app.selected_entry() else { continue };
                            if ent.kind != "dir" {
                                app.status = "not a directory".to_string();
                                continue;
                            }
                            let next_path = if app.path.is_empty() {
                                ent.name.clone()
                            } else {
                                format!("{}/{}", app.path, ent.name)
                            };
                            match rt.block_on(fetch_tree(client, server, &id, &next_path)) {
                                Ok(tr) => {
                                    app.path = tr.path;
                                    app.entries = tr.entries;
                                    app.tree_state.select(if app.entries.is_empty() { None } else { Some(0) });
                                }
                                Err(e) => app.status = format!("error: {e}"),
                            }
                        }
                    },
                    KeyCode::Backspace | KeyCode::Char('b') => {
                        if app.focus != Focus::Tree {
                            continue;
                        }
                        let Some(id) = app.snapshot_id.clone() else { continue };

                        if app.path.is_empty() {
                            app.status = "at snapshot root".to_string();
                            continue;
                        }

                        let up = match app.path.rsplit_once('/') {
                            None => String::new(),
                            Some((parent, _)) => parent.to_string(),
                        };
                        match rt.block_on(fetch_tree(client, server, &id, &up)) {
                            Ok(tr) => {
                                app.path = tr.path;
                                app.entries = tr.entries;
                                app.tree_state.select(if app.entries.is_empty() { None } else { Some(0) });
                            }
                            Err(e) => app.status = format!("error: {e}"),
                        }
                    }
                    KeyCode::Char('c') => {
                        // Escape hatch for confusing state.
                        app.reset_tree();
                        app.status = "cleared tree; select snapshot again".to_string();
                        app.focus = Focus::Snapshots;
                    }
                    _ => {}
                }
            }
        }
    }
}

fn ui(f: &mut ratatui::Frame<'_>, app: &mut App) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(f.area());

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(areas[0]);

    let focus_style = Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD);

    // Left: snapshots
    let title = match app.focus {
        Focus::Snapshots => Line::from(vec![Span::styled(" Snapshots ", focus_style)]),
        _ => Line::from(" Snapshots "),
    };
    let snap_items: Vec<ListItem> = app
        .snapshots
        .iter()
        .map(|s| {
            let line = format!(
                "{}  {}",
                s.snapshot_id,
                s.device_name
            );
            ListItem::new(line)
        })
        .collect();
    let snaps = List::new(snap_items)
        .block(Block::default().borders(Borders::ALL).title(title))
        .highlight_style(Style::default().bg(Color::Blue).fg(Color::White))
        .highlight_symbol(">> ");
    f.render_stateful_widget(snaps, main[0], &mut app.snapshots_state);

    // Right: tree
    let tree_title = {
        let head = match app.snapshot_id.as_deref() {
            None => " Tree (no snapshot) ".to_string(),
            Some(id) => {
                let p = if app.path.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", app.path)
                };
                format!(" Tree {id} {p} ")
            }
        };
        match app.focus {
            Focus::Tree => Line::from(vec![Span::styled(format!(" {head} "), focus_style)]),
            _ => Line::from(format!(" {head} ")),
        }
    };

    let tree_items: Vec<ListItem> = app
        .entries
        .iter()
        .map(|e| {
            let prefix = if e.kind == "dir" { "[D] " } else { "    " };
            let line = format!("{prefix}{}", e.name);
            ListItem::new(line)
        })
        .collect();
    let tree = List::new(tree_items)
        .block(Block::default().borders(Borders::ALL).title(tree_title))
        .highlight_style(Style::default().bg(Color::Blue).fg(Color::White))
        .highlight_symbol(">> ");
    f.render_stateful_widget(tree, main[1], &mut app.tree_state);

    // Status bar
    let status = Paragraph::new(app.status.clone())
        .block(Block::default().borders(Borders::ALL).title(" Status "));
    f.render_widget(status, areas[1]);
}
